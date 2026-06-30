import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  AgentEventRecord,
  AgentEventKind,
  ConversationLogStore,
} from "./conversation-log.js";
import type { TurnAttemptRecord, TurnAttemptStore } from "./turnrunner.js";
import type { EnvironmentIssue, EnvironmentIssueStore } from "./machine-environment.js";

/**
 * Postgres row shape for `agent_sessions`. A session is the stable conversation
 * context scoped to an agent instance id (`discord:thread:<id>` or
 * `setup:<runId>`). It survives process restart for non-terminal tasks.
 */
export interface AgentSessionRecord {
  agent_instance_id: string;
  task_id: string | null;
  setup_run_id: string | null;
  role: "coding" | "setup" | "thread-namer";
  repo: string | null;
  branch: string | null;
  workspace_path: string | null;
  agent_type: string;
  cwd: string | null;
  env_names: string[] | null;
  setup_profile_revision: number | null;
  status: "active" | "closed";
  created_at: Date;
  updated_at: Date;
}

/**
 * Postgres row shape for `agent_turns`. Each row represents one turn
 * (a single prompt execution) within an agent session.
 */
export interface AgentTurnRecord {
  turn_id: string;
  agent_instance_id: string;
  discord_message_id: string | null;
  instruction_hash: string | null;
  role: "coding" | "setup" | "thread-namer";
  queued_at: Date | null;
  started_at: Date | null;
  terminal_at: Date | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "aborted";
  active_attempt_id: string | null;
  idempotency_key: string | null;
  created_at: Date;
}

/**
 * Store interface for `agent_sessions` and `agent_turns`. The real
 * implementation is Postgres-backed; unit tests use an in-memory fake.
 */
export interface AgentSessionStore {
  createSession(record: Omit<AgentSessionRecord, "created_at" | "updated_at">): Promise<AgentSessionRecord>;
  getSession(instanceId: string): Promise<AgentSessionRecord | undefined>;
  updateSessionStatus(instanceId: string, status: "active" | "closed"): Promise<void>;
  createTurn(record: Omit<AgentTurnRecord, "created_at">): Promise<AgentTurnRecord>;
  getTurn(turnId: string): Promise<AgentTurnRecord | undefined>;
  findTurnByIdempotencyKey(instanceId: string, idempotencyKey: string): Promise<AgentTurnRecord | undefined>;
  updateTurn(turnId: string, patch: Partial<AgentTurnRecord>): Promise<AgentTurnRecord | undefined>;
  listTurnsBySession(instanceId: string): Promise<AgentTurnRecord[]>;
}

/**
 * Combined persistence interface for all AgentTurn-owned Postgres tables.
 * Includes the migration that creates the tables.
 */
export interface AgentTurnPersistence extends AgentSessionStore, EnvironmentIssueStore {
  migrate(): Promise<void>;
}

export class PostgresAgentTurnPersistence implements AgentTurnPersistence {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_instance_id TEXT PRIMARY KEY,
        task_id TEXT,
        setup_run_id TEXT,
        role TEXT NOT NULL,
        repo TEXT,
        branch TEXT,
        workspace_path TEXT,
        agent_type TEXT NOT NULL DEFAULT 'pi',
        cwd TEXT,
        env_names TEXT[],
        setup_profile_revision INT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT agent_sessions_status_check CHECK (status IN ('active', 'closed'))
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_turns (
        turn_id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL REFERENCES agent_sessions(agent_instance_id),
        discord_message_id TEXT,
        instruction_hash TEXT,
        role TEXT NOT NULL,
        queued_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        terminal_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'queued',
        active_attempt_id TEXT,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT agent_turns_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'aborted'))
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        attempt_id TEXT,
        seq BIGINT NOT NULL,
        attempt_seq BIGINT NOT NULL,
        event_kind TEXT NOT NULL,
        payload JSONB,
        superseded BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_turn_attempts (
        attempt_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        attempt_number INT NOT NULL,
        lease_owner TEXT,
        heartbeat_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        timeout_ms BIGINT,
        retry_reason TEXT,
        terminal_reason TEXT,
        terminal_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        CONSTRAINT agent_turn_attempts_status_check CHECK (status IN ('active', 'completed', 'failed', 'interrupted'))
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_environment_issues (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        setup_id TEXT,
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        required_env TEXT[],
        blocked_host TEXT,
        blocked_port INT,
        package_name TEXT,
        suggested_action TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_events_session_id_idx ON agent_events(session_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_events_attempt_id_idx ON agent_events(attempt_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_turn_attempts_turn_id_idx ON agent_turn_attempts(turn_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_turn_attempts_status_idx ON agent_turn_attempts(status)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_environment_issues_task_id_idx ON agent_environment_issues(task_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_environment_issues_setup_id_idx ON agent_environment_issues(setup_id)
    `);
  }

  async createSession(record: Omit<AgentSessionRecord, "created_at" | "updated_at">): Promise<AgentSessionRecord> {
    const now = new Date();
    await this.pool.query(
      `
        INSERT INTO agent_sessions (
          agent_instance_id, task_id, setup_run_id, role, repo, branch,
          workspace_path, agent_type, cwd, env_names, setup_profile_revision, status,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
      `,
      [
        record.agent_instance_id,
        record.task_id,
        record.setup_run_id,
        record.role,
        record.repo,
        record.branch,
        record.workspace_path,
        record.agent_type,
        record.cwd,
        record.env_names,
        record.setup_profile_revision,
        record.status,
        now,
      ],
    );
    return { ...record, created_at: now, updated_at: now };
  }

  async getSession(instanceId: string): Promise<AgentSessionRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM agent_sessions WHERE agent_instance_id = $1`,
      [instanceId],
    );
    return result.rows[0] ? rowToSessionRecord(result.rows[0]) : undefined;
  }

  async updateSessionStatus(instanceId: string, status: "active" | "closed"): Promise<void> {
    await this.pool.query(
      `UPDATE agent_sessions SET status = $1, updated_at = now() WHERE agent_instance_id = $2`,
      [status, instanceId],
    );
  }

  async createTurn(record: Omit<AgentTurnRecord, "created_at">): Promise<AgentTurnRecord> {
    const now = new Date();
    await this.pool.query(
      `
        INSERT INTO agent_turns (
          turn_id, agent_instance_id, discord_message_id, instruction_hash, role,
          queued_at, started_at, terminal_at, status, active_attempt_id, idempotency_key, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        record.turn_id,
        record.agent_instance_id,
        record.discord_message_id,
        record.instruction_hash,
        record.role,
        record.queued_at,
        record.started_at,
        record.terminal_at,
        record.status,
        record.active_attempt_id,
        record.idempotency_key,
        now,
      ],
    );
    return { ...record, created_at: now };
  }

  async getTurn(turnId: string): Promise<AgentTurnRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turns WHERE turn_id = $1`,
      [turnId],
    );
    return result.rows[0] ? rowToTurnRecord(result.rows[0]) : undefined;
  }

  async findTurnByIdempotencyKey(instanceId: string, idempotencyKey: string): Promise<AgentTurnRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turns WHERE agent_instance_id = $1 AND idempotency_key = $2`,
      [instanceId, idempotencyKey],
    );
    return result.rows[0] ? rowToTurnRecord(result.rows[0]) : undefined;
  }

  async updateTurn(turnId: string, patch: Partial<AgentTurnRecord>): Promise<AgentTurnRecord | undefined> {
    const allowed = ["discord_message_id", "instruction_hash", "role", "queued_at", "started_at", "terminal_at", "status", "active_attempt_id", "idempotency_key"] as const;
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key as typeof allowed[number]));
    if (entries.length === 0) return this.getTurn(turnId);
    const setters = entries.map(([key], idx) => `${key} = $${idx + 2}`).join(", ");
    const values = entries.map(([, value]) => value);
    const result = await this.pool.query(
      `UPDATE agent_turns SET ${setters} WHERE turn_id = $1 RETURNING *`,
      [turnId, ...values],
    );
    return result.rows[0] ? rowToTurnRecord(result.rows[0]) : undefined;
  }

  async listTurnsBySession(instanceId: string): Promise<AgentTurnRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turns WHERE agent_instance_id = $1 ORDER BY created_at ASC`,
      [instanceId],
    );
    return result.rows.map(rowToTurnRecord);
  }

  async insert(issue: Omit<EnvironmentIssue, "createdAt">): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_environment_issues (
          id, task_id, setup_id, severity, kind, message, required_env,
          blocked_host, blocked_port, package_name, suggested_action, resolved_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      `,
      [
        issue.id,
        issue.taskId ?? null,
        issue.setupId ?? null,
        issue.severity,
        issue.kind,
        issue.message,
        issue.requiredEnv ?? null,
        issue.blockedHost ?? null,
        issue.blockedPort ?? null,
        issue.packageName ?? null,
        issue.suggestedAction ?? null,
        issue.resolvedAt ?? null,
      ],
    );
  }

  async listUnresolved(): Promise<EnvironmentIssue[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_environment_issues WHERE resolved_at IS NULL ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToEnvironmentIssue);
  }

  async resolve(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_environment_issues SET resolved_at = now() WHERE id = $1`,
      [id],
    );
  }
}

export class PostgresConversationLogStore implements ConversationLogStore {
  constructor(private readonly pool: Pool) {}

  async insert(record: Omit<AgentEventRecord, "id" | "created_at">): Promise<AgentEventRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO agent_events (
          session_id, turn_id, attempt_id, seq, attempt_seq, event_kind, payload, superseded
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, created_at
      `,
      [
        record.session_id,
        record.turn_id,
        record.attempt_id,
        record.seq,
        record.attempt_seq,
        record.event_kind,
        JSON.stringify(record.payload),
        record.superseded,
      ],
    );
    return {
      ...record,
      id: Number(result.rows[0]?.id ?? 0),
      created_at: new Date(result.rows[0]?.created_at ?? Date.now()),
    };
  }

  async listBySessionId(sessionId: string): Promise<AgentEventRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_events WHERE session_id = $1 ORDER BY seq ASC`,
      [sessionId],
    );
    return result.rows.map(rowToEventRecord);
  }

  async listByAttemptId(attemptId: string): Promise<AgentEventRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_events WHERE attempt_id = $1 ORDER BY seq ASC`,
      [attemptId],
    );
    return result.rows.map(rowToEventRecord);
  }

  async markSuperseded(attemptId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_events SET superseded = true WHERE attempt_id = $1 AND superseded = false`,
      [attemptId],
    );
    return result.rowCount ?? 0;
  }
}

export class PostgresTurnAttemptStore implements TurnAttemptStore {
  constructor(private readonly pool: Pool) {}

  async insert(record: TurnAttemptRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_turn_attempts (
          attempt_id, turn_id, attempt_number, lease_owner, heartbeat_at, started_at,
          timeout_ms, retry_reason, terminal_reason, terminal_at, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        record.attempt_id,
        record.turn_id,
        record.attempt_number,
        record.lease_owner,
        record.heartbeat_at,
        record.started_at,
        record.timeout_ms,
        record.retry_reason,
        record.terminal_reason,
        record.terminal_at,
        record.status,
      ],
    );
  }

  async get(attemptId: string): Promise<TurnAttemptRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turn_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    return result.rows[0] ? rowToAttemptRecord(result.rows[0]) : undefined;
  }

  async listByTurnId(turnId: string): Promise<TurnAttemptRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turn_attempts WHERE turn_id = $1 ORDER BY attempt_number ASC`,
      [turnId],
    );
    return result.rows.map(rowToAttemptRecord);
  }

  async listActive(): Promise<TurnAttemptRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_turn_attempts WHERE status = 'active' ORDER BY started_at ASC`,
    );
    return result.rows.map(rowToAttemptRecord);
  }

  async update(attemptId: string, patch: Partial<TurnAttemptRecord>): Promise<TurnAttemptRecord | undefined> {
    const allowed = ["lease_owner", "heartbeat_at", "timeout_ms", "retry_reason", "terminal_reason", "terminal_at", "status"] as const;
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key as typeof allowed[number]));
    if (entries.length === 0) return this.get(attemptId);
    const setters = entries.map(([key], idx) => `${key} = $${idx + 2}`).join(", ");
    const values = entries.map(([, value]) => value);
    const result = await this.pool.query(
      `UPDATE agent_turn_attempts SET ${setters} WHERE attempt_id = $1 RETURNING *`,
      [attemptId, ...values],
    );
    return result.rows[0] ? rowToAttemptRecord(result.rows[0]) : undefined;
  }
}

export class InMemoryAgentTurnPersistence implements AgentTurnPersistence {
  private sessions: AgentSessionRecord[] = [];
  private turns: AgentTurnRecord[] = [];
  private issues: EnvironmentIssue[] = [];
  private nextEventId = 1;
  private turnAttemptRecords: TurnAttemptRecord[] = [];
  private eventRecords: AgentEventRecord[] = [];

  async migrate(): Promise<void> {
    // In-memory store has no schema to create.
  }

  async createSession(record: Omit<AgentSessionRecord, "created_at" | "updated_at">): Promise<AgentSessionRecord> {
    const now = new Date();
    const full: AgentSessionRecord = { ...record, created_at: now, updated_at: now };
    this.sessions.push({ ...full });
    return { ...full };
  }

  async getSession(instanceId: string): Promise<AgentSessionRecord | undefined> {
    return this.sessions.find((s) => s.agent_instance_id === instanceId);
  }

  async updateSessionStatus(instanceId: string, status: "active" | "closed"): Promise<void> {
    const session = this.sessions.find((s) => s.agent_instance_id === instanceId);
    if (session) {
      session.status = status;
      session.updated_at = new Date();
    }
  }

  async createTurn(record: Omit<AgentTurnRecord, "created_at">): Promise<AgentTurnRecord> {
    const now = new Date();
    const full: AgentTurnRecord = { ...record, created_at: now };
    this.turns.push({ ...full });
    return { ...full };
  }

  async getTurn(turnId: string): Promise<AgentTurnRecord | undefined> {
    return this.turns.find((t) => t.turn_id === turnId);
  }

  async findTurnByIdempotencyKey(instanceId: string, idempotencyKey: string): Promise<AgentTurnRecord | undefined> {
    return this.turns.find(
      (t) => t.agent_instance_id === instanceId && t.idempotency_key === idempotencyKey,
    );
  }

  async updateTurn(turnId: string, patch: Partial<AgentTurnRecord>): Promise<AgentTurnRecord | undefined> {
    const turn = this.turns.find((t) => t.turn_id === turnId);
    if (!turn) return undefined;
    Object.assign(turn, patch);
    return { ...turn };
  }

  async listTurnsBySession(instanceId: string): Promise<AgentTurnRecord[]> {
    return this.turns
      .filter((t) => t.agent_instance_id === instanceId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  async insert(issue: Omit<EnvironmentIssue, "createdAt">): Promise<void> {
    this.issues.push({ ...issue, createdAt: new Date() });
  }

  async listUnresolved(): Promise<EnvironmentIssue[]> {
    return this.issues.filter((i) => i.resolvedAt === undefined);
  }

  async resolve(id: string): Promise<void> {
    const issue = this.issues.find((i) => i.id === id);
    if (issue) issue.resolvedAt = new Date();
  }
}

function rowToSessionRecord(row: Record<string, unknown>): AgentSessionRecord {
  return {
    agent_instance_id: String(row.agent_instance_id),
    task_id: row.task_id === null ? null : row.task_id === undefined ? null : String(row.task_id),
    setup_run_id: row.setup_run_id === null ? null : row.setup_run_id === undefined ? null : String(row.setup_run_id),
    role: String(row.role) as AgentSessionRecord["role"],
    repo: row.repo === null ? null : row.repo === undefined ? null : String(row.repo),
    branch: row.branch === null ? null : row.branch === undefined ? null : String(row.branch),
    workspace_path: row.workspace_path === null ? null : row.workspace_path === undefined ? null : String(row.workspace_path),
    agent_type: String(row.agent_type ?? "pi"),
    cwd: row.cwd === null ? null : row.cwd === undefined ? null : String(row.cwd),
    env_names: Array.isArray(row.env_names) ? row.env_names.map(String) : null,
    setup_profile_revision: row.setup_profile_revision === null ? null : Number(row.setup_profile_revision),
    status: String(row.status) as AgentSessionRecord["status"],
    created_at: rowToDate(row.created_at),
    updated_at: rowToDate(row.updated_at),
  };
}

function rowToTurnRecord(row: Record<string, unknown>): AgentTurnRecord {
  return {
    turn_id: String(row.turn_id),
    agent_instance_id: String(row.agent_instance_id),
    discord_message_id: row.discord_message_id === null ? null : String(row.discord_message_id),
    instruction_hash: row.instruction_hash === null ? null : String(row.instruction_hash),
    role: String(row.role) as AgentTurnRecord["role"],
    queued_at: row.queued_at === null ? null : rowToDate(row.queued_at),
    started_at: row.started_at === null ? null : rowToDate(row.started_at),
    terminal_at: row.terminal_at === null ? null : rowToDate(row.terminal_at),
    status: String(row.status) as AgentTurnRecord["status"],
    active_attempt_id: row.active_attempt_id === null ? null : String(row.active_attempt_id),
    idempotency_key: row.idempotency_key === null ? null : String(row.idempotency_key),
    created_at: rowToDate(row.created_at),
  };
}

function rowToEventRecord(row: Record<string, unknown>): AgentEventRecord {
  return {
    id: Number(row.id),
    session_id: String(row.session_id),
    turn_id: row.turn_id === null ? "" : String(row.turn_id),
    attempt_id: row.attempt_id === null ? "" : String(row.attempt_id),
    seq: Number(row.seq),
    attempt_seq: Number(row.attempt_seq),
    event_kind: String(row.event_kind) as AgentEventKind,
    payload: row.payload ?? null,
    superseded: Boolean(row.superseded),
    created_at: rowToDate(row.created_at),
  };
}

function rowToAttemptRecord(row: Record<string, unknown>): TurnAttemptRecord {
  return {
    attempt_id: String(row.attempt_id),
    turn_id: String(row.turn_id),
    attempt_number: Number(row.attempt_number),
    lease_owner: String(row.lease_owner),
    heartbeat_at: rowToDate(row.heartbeat_at),
    started_at: rowToDate(row.started_at),
    timeout_ms: Number(row.timeout_ms),
    retry_reason: row.retry_reason === null ? null : String(row.retry_reason),
    terminal_reason: row.terminal_reason === null ? null : String(row.terminal_reason),
    terminal_at: row.terminal_at === null ? null : rowToDate(row.terminal_at),
    status: String(row.status) as TurnAttemptRecord["status"],
  };
}

function rowToEnvironmentIssue(row: Record<string, unknown>): EnvironmentIssue {
  const issue: EnvironmentIssue = {
    id: String(row.id),
    severity: String(row.severity) as EnvironmentIssue["severity"],
    kind: String(row.kind) as EnvironmentIssue["kind"],
    message: String(row.message),
    createdAt: rowToDate(row.created_at),
  };
  if (row.task_id !== null && row.task_id !== undefined) {
    issue.taskId = String(row.task_id);
  }
  if (row.setup_id !== null && row.setup_id !== undefined) {
    issue.setupId = String(row.setup_id);
  }
  if (Array.isArray(row.required_env)) {
    issue.requiredEnv = row.required_env.map(String);
  }
  if (row.blocked_host !== null && row.blocked_host !== undefined) {
    issue.blockedHost = String(row.blocked_host);
  }
  if (row.blocked_port !== null && row.blocked_port !== undefined) {
    issue.blockedPort = Number(row.blocked_port);
  }
  if (row.package_name !== null && row.package_name !== undefined) {
    issue.packageName = String(row.package_name);
  }
  if (row.suggested_action !== null && row.suggested_action !== undefined) {
    issue.suggestedAction = String(row.suggested_action);
  }
  if (row.resolved_at !== null && row.resolved_at !== undefined) {
    issue.resolvedAt = rowToDate(row.resolved_at);
  }
  return issue;
}

function rowToDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date();
}

function hashInstruction(instruction: string): string {
  // Simple stable hash for instruction deduplication. Not cryptographically secure,
  // but sufficient for transcript integrity checks and duplicate detection.
  let h = 0;
  for (let i = 0; i < instruction.length; i++) {
    h = ((h << 5) - h + instruction.charCodeAt(i)) | 0;
  }
  return `hash-${Math.abs(h).toString(16)}`;
}

export { hashInstruction };
