import type { Pool, QueryResultRow } from "pg";
import {
  SETUP_DRAFT_VALIDATION_STATUSES,
  SETUP_PROFILE_STATUSES,
  SETUP_RUN_STATUSES,
  type SetupDraft,
  type SetupDraftValidationStatus,
  type SetupEnvironment,
  type SetupProfile,
  type SetupProfileStatus,
  type SetupRun,
  type SetupRunStatus,
  newSetupId,
  parseSetupProfileKey,
  validateSetupEnvironment,
  validateSetupProfilePayload,
} from "./profile.js";

export class SetupStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS setup_profiles (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        environment_json JSONB NOT NULL,
        memory_markdown TEXT NOT NULL,
        last_run_id TEXT,
        error_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (repo, branch)
      )
    `);
    await this.pool.query(`
      ALTER TABLE setup_profiles DROP CONSTRAINT IF EXISTS setup_profiles_status_check
    `);
    await this.pool.query(`
      ALTER TABLE setup_profiles ADD CONSTRAINT setup_profiles_status_check
      CHECK (status IN ('running', 'ready', 'failed', 'updating'))
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS setup_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        error_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      ALTER TABLE setup_runs DROP CONSTRAINT IF EXISTS setup_runs_status_check
    `);
    await this.pool.query(`
      ALTER TABLE setup_runs ADD CONSTRAINT setup_runs_status_check
      CHECK (status IN ('running', 'succeeded', 'failed'))
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS setup_drafts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES setup_profiles(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        environment_json JSONB NOT NULL,
        memory_markdown TEXT NOT NULL,
        validation_status TEXT NOT NULL DEFAULT 'unchecked',
        validation_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      ALTER TABLE setup_drafts DROP CONSTRAINT IF EXISTS setup_drafts_validation_status_check
    `);
    await this.pool.query(`
      ALTER TABLE setup_drafts ADD CONSTRAINT setup_drafts_validation_status_check
      CHECK (validation_status IN ('unchecked', 'valid', 'invalid'))
    `);
  }

  async getReadyProfile(
    repo: string,
    branch: string,
  ): Promise<SetupProfile | undefined> {
    const key = parseSetupProfileKey(repo, branch);
    if (!key.ok) return undefined;
    const result = await this.pool.query(
      `
        SELECT * FROM setup_profiles
        WHERE repo = $1 AND branch = $2 AND status = 'ready'
      `,
      [key.value.repo, key.value.branch],
    );
    return result.rows[0] ? rowToProfile(result.rows[0]) : undefined;
  }

  async getProfile(
    repo: string,
    branch: string,
  ): Promise<SetupProfile | undefined> {
    const key = parseSetupProfileKey(repo, branch);
    if (!key.ok) return undefined;
    const result = await this.pool.query(
      "SELECT * FROM setup_profiles WHERE repo = $1 AND branch = $2",
      [key.value.repo, key.value.branch],
    );
    return result.rows[0] ? rowToProfile(result.rows[0]) : undefined;
  }

  async getProfileById(profileId: string): Promise<SetupProfile | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM setup_profiles WHERE id = $1",
      [profileId],
    );
    return result.rows[0] ? rowToProfile(result.rows[0]) : undefined;
  }

  async createOrStartRun(input: {
    repo: string;
    branch: string;
    model: string;
    workspacePath: string;
    update: boolean;
  }): Promise<{ profile: SetupProfile; run: SetupRun }> {
    const key = parseSetupProfileKey(input.repo, input.branch);
    if (!key.ok) throw new Error(key.message);
    const profileId = newSetupId();
    const runId = newSetupId();
    const emptyEnvironment: SetupEnvironment = {
      install: "true",
      start: "",
      checks: {},
      requiredEnv: [],
      requiredServices: [],
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profileResult = await client.query(
        `
          INSERT INTO setup_profiles (
            id, repo, branch, status, revision, environment_json, memory_markdown, last_run_id
          )
          VALUES ($1, $2, $3, 'running', 0, $4::jsonb, $5, $6)
          ON CONFLICT (repo, branch) DO UPDATE
          SET status = CASE
                WHEN setup_profiles.status = 'ready' THEN 'updating'
                ELSE 'running'
              END,
              last_run_id = $6,
              error_summary = NULL,
              updated_at = now()
          WHERE ($7::boolean AND setup_profiles.status IN ('ready', 'failed'))
             OR (NOT $7::boolean AND setup_profiles.status = 'failed')
          RETURNING *
        `,
        [
          profileId,
          key.value.repo,
          key.value.branch,
          JSON.stringify(emptyEnvironment),
          "Setup is running.",
          runId,
          input.update,
        ],
      );
      if (!profileResult.rows[0]) {
        throw new Error(
          `Setup profile for ${key.value.repo} on ${key.value.branch} is not available for this action.`,
        );
      }
      const profile = rowToProfile(profileResult.rows[0]);
      const runResult = await client.query(
        `
          INSERT INTO setup_runs (
            id, profile_id, repo, branch, model, workspace_path, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'running')
          RETURNING *
        `,
        [
          runId,
          profile.id,
          profile.repo,
          profile.branch,
          input.model,
          input.workspacePath,
        ],
      );
      await client.query("COMMIT");
      return { profile, run: rowToRun(singleRow(runResult.rows)) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRunByInstanceId(instanceId: string): Promise<SetupRun | undefined> {
    const runId = instanceId.startsWith("setup:") ? instanceId.slice(6) : "";
    if (!runId) return undefined;
    const result = await this.pool.query("SELECT * FROM setup_runs WHERE id = $1", [
      runId,
    ]);
    return result.rows[0] ? rowToRun(result.rows[0]) : undefined;
  }

  async promoteRun(input: {
    runId: string;
    environment: SetupEnvironment;
    memoryMarkdown: string;
  }): Promise<SetupProfile> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runResult = await client.query(
        "SELECT * FROM setup_runs WHERE id = $1 FOR UPDATE",
        [input.runId],
      );
      const run = rowToRun(singleRow(runResult.rows));
      if (run.status !== "running") {
        throw new Error(`Setup run ${run.id} is already ${run.status}.`);
      }
      const profileResult = await client.query(
        `
          UPDATE setup_profiles
          SET status = 'ready',
              revision = revision + 1,
              environment_json = $2::jsonb,
              memory_markdown = $3,
              last_run_id = $4,
              error_summary = NULL,
              updated_at = now()
          WHERE id = $1
            AND status IN ('running', 'updating')
          RETURNING *
        `,
        [
          run.profileId,
          JSON.stringify(input.environment),
          input.memoryMarkdown,
          run.id,
        ],
      );
      await client.query(
        `
          UPDATE setup_runs
          SET status = 'succeeded', error_summary = NULL, updated_at = now()
          WHERE id = $1 AND status = 'running'
        `,
        [run.id],
      );
      await client.query("COMMIT");
      return rowToProfile(singleRow(profileResult.rows));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failRun(runId: string, errorSummary: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE setup_runs
          SET status = 'failed', error_summary = $2, updated_at = now()
          WHERE id = $1 AND status = 'running'
        `,
        [runId, errorSummary],
      );
      await client.query(
        `
          UPDATE setup_profiles
          SET status = CASE WHEN revision > 0 THEN 'ready' ELSE 'failed' END,
              error_summary = $2,
              updated_at = now()
          WHERE last_run_id = $1 AND status IN ('running', 'updating')
        `,
        [runId, errorSummary],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createDraft(
    profileId: string,
    discordUserId: string,
  ): Promise<SetupDraft> {
    const profile = await this.getProfileById(profileId);
    if (!profile) throw new Error("Setup profile not found.");
    const result = await this.pool.query(
      `
        INSERT INTO setup_drafts (
          id, profile_id, discord_user_id, base_revision, environment_json, memory_markdown
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        RETURNING *
      `,
      [
        newSetupId(),
        profile.id,
        discordUserId,
        profile.revision,
        JSON.stringify(profile.environment),
        profile.memoryMarkdown,
      ],
    );
    return rowToDraft(singleRow(result.rows));
  }

  async getDraft(draftId: string): Promise<SetupDraft | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM setup_drafts WHERE id = $1",
      [draftId],
    );
    return result.rows[0] ? rowToDraft(result.rows[0]) : undefined;
  }

  async updateDraft(input: {
    draftId: string;
    environment?: SetupEnvironment;
    memoryMarkdown?: string;
    validationStatus?: SetupDraftValidationStatus;
    validationMessage?: string;
  }): Promise<SetupDraft> {
    const draft = await this.getDraft(input.draftId);
    if (!draft) throw new Error("Draft not found.");
    const environment = input.environment ?? draft.environment;
    const memoryMarkdown = input.memoryMarkdown ?? draft.memoryMarkdown;
    const validationStatus = input.validationStatus ?? "unchecked";
    const result = await this.pool.query(
      `
        UPDATE setup_drafts
        SET environment_json = $2::jsonb,
            memory_markdown = $3,
            validation_status = $4,
            validation_message = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        input.draftId,
        JSON.stringify(environment),
        memoryMarkdown,
        validationStatus,
        input.validationMessage ?? null,
      ],
    );
    return rowToDraft(singleRow(result.rows));
  }

  async applyDraft(draftId: string): Promise<
    | { ok: true; profile: SetupProfile }
    | { ok: false; reason: "conflict" | "invalid" | "missing" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draftResult = await client.query(
        "SELECT * FROM setup_drafts WHERE id = $1 FOR UPDATE",
        [draftId],
      );
      if (!draftResult.rows[0]) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "missing" };
      }
      const draft = rowToDraft(draftResult.rows[0]);
      const validation = validateSetupProfilePayload({
        environment: draft.environment,
        memoryMarkdown: draft.memoryMarkdown,
      });
      if (!validation.ok || draft.validationStatus === "invalid") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "invalid" };
      }
      const result = await client.query(
        `
          UPDATE setup_profiles
          SET environment_json = $3::jsonb,
              memory_markdown = $4,
              revision = revision + 1,
              status = 'ready',
              error_summary = NULL,
              updated_at = now()
          WHERE id = $1 AND revision = $2
          RETURNING *
        `,
        [
          draft.profileId,
          draft.baseRevision,
          JSON.stringify(draft.environment),
          draft.memoryMarkdown,
        ],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "conflict" };
      }
      await client.query("DELETE FROM setup_drafts WHERE id = $1", [draft.id]);
      await client.query("COMMIT");
      return { ok: true, profile: rowToProfile(result.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async discardDraft(draftId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM setup_drafts WHERE id = $1",
      [draftId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function rowToProfile(row: QueryResultRow): SetupProfile {
  return {
    id: String(row.id),
    repo: String(row.repo),
    branch: String(row.branch),
    status: parseProfileStatus(row.status),
    revision: Number(row.revision),
    environment: parseEnvironment(row.environment_json),
    memoryMarkdown: String(row.memory_markdown),
    ...(typeof row.last_run_id === "string" ? { lastRunId: row.last_run_id } : {}),
    ...(typeof row.error_summary === "string"
      ? { errorSummary: row.error_summary }
      : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function rowToRun(row: QueryResultRow): SetupRun {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    repo: String(row.repo),
    branch: String(row.branch),
    model: String(row.model),
    workspacePath: String(row.workspace_path),
    status: parseRunStatus(row.status),
    ...(typeof row.error_summary === "string"
      ? { errorSummary: row.error_summary }
      : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function rowToDraft(row: QueryResultRow): SetupDraft {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    discordUserId: String(row.discord_user_id),
    baseRevision: Number(row.base_revision),
    environment: parseEnvironment(row.environment_json),
    memoryMarkdown: String(row.memory_markdown),
    validationStatus: parseDraftValidationStatus(row.validation_status),
    ...(typeof row.validation_message === "string"
      ? { validationMessage: row.validation_message }
      : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function parseEnvironment(value: unknown): SetupEnvironment {
  const parsed = validateSetupEnvironment(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function parseProfileStatus(value: unknown): SetupProfileStatus {
  if (
    typeof value === "string" &&
    (SETUP_PROFILE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as SetupProfileStatus;
  }
  throw new Error(`Invalid setup profile status: ${String(value)}`);
}

function parseRunStatus(value: unknown): SetupRunStatus {
  if (
    typeof value === "string" &&
    (SETUP_RUN_STATUSES as readonly string[]).includes(value)
  ) {
    return value as SetupRunStatus;
  }
  throw new Error(`Invalid setup run status: ${String(value)}`);
}

function parseDraftValidationStatus(
  value: unknown,
): SetupDraftValidationStatus {
  if (
    typeof value === "string" &&
    (SETUP_DRAFT_VALIDATION_STATUSES as readonly string[]).includes(value)
  ) {
    return value as SetupDraftValidationStatus;
  }
  throw new Error(`Invalid setup draft validation status: ${String(value)}`);
}

function singleRow<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected one row");
  return row;
}
