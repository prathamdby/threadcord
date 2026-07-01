# Cursor Cloud Agent Setup

## Cursor Cloud specific instructions

Threadcord is a single Node/TypeScript service: a Discord bot + small Hono HTTP server
that runs agentOS coding-agent tasks. See `README.md` for the product overview and the full
list of commands; this section only records non-obvious cloud-environment caveats.

### Naming
- Write **agentOS** in prose and commit messages, not `AgentOS` or `Agent OS`.
- Lowercase `agentos` is only for npm scopes (`@rivet-dev/agentos-core`) and env vars
  (`AGENTOS_SIDECAR_BIN`). See `CONTEXT.md` → Naming.

### MCP servers → ACP session/new
- Registered MCP servers live in Postgres (`mcp_servers`). Before each coding turn,
  `DefaultMcpRegistry.materializeConfig()` writes `.mcp.json` and returns configs for
  `agentOs.createSession()`.
- The sidecar forwards `mcpServers` JSON to ACP `session/new` **without translation**.
  Each entry must match the ACP schema in `src/mcp/acp-config.ts`:
  - `type`: `"http"` (transport `streamable-http` or default) or `"sse"`
  - `name`: server id
  - `url`: remote MCP URL
  - `headers`: `[{ name, value }]` array (required; use `[]` when empty)
- Do **not** emit agentos-core host shape `{ type: "remote", headers: Record }` — ACP
  rejects it and turns fail pre-start with `session/new failed: Invalid params`.

### Node version (important)
- Threadcord targets Node `>=22.18`. The base image's `/exec-daemon/node` is `22.14`, which makes
  `npm run build` and `npm run dev` fail with "Unsupported Node version" warnings from some dependencies.
- The required version (`v22.22.2`) is installed via nvm and `~/.bashrc` is configured to put it
  first on `PATH`, so interactive agent shells get it automatically (`node --version` → `v22.22.2`).
- If a shell ever shows `22.14`, run: `export PATH="$NVM_DIR/versions/node/v22.22.2/bin:$PATH"`.
- `npm install` works on either Node version (the engine mismatch is only a warning).

### PostgreSQL (required service, not in the update script)
- The app needs Postgres; `DATABASE_URL` is mandatory. A local cluster (PostgreSQL 16, cluster
  `main`) is provisioned with db/user/password all `threadcord`, matching the `.env` default.
- Start it if not running: `sudo pg_ctlcluster 16 main start`
- Quick check: `PGPASSWORD=threadcord psql -h localhost -U threadcord -d threadcord -c '\dt'`
- On boot the app runs `store.migrate()` / `setupStore.migrate()` / `mcpStore.migrate()` /
  `agentTurnPersistence.migrate()`, creating the Threadcord-owned tables (`tasks`, `setup_profiles`,
  `mcp_servers`, `agent_sessions`, `agent_turns`, `agent_events`, `agent_turn_attempts`, etc.).
  Migrations are idempotent. The agentOS runtime itself manages its own state outside Postgres.

### Running the app
- Dev: `npm run dev` runs `tsx watch src/server.ts` on port `3583`. `tsx` loads `.env` automatically.
- `node dist/server.js` (`npm start`) does NOT load `.env` — it reads the real process env, so
  export the variables (or use the Docker/compose path) when running the built server directly.
- `.env` is gitignored. A local dev `.env` exists with placeholder Discord/GitHub/provider values.
- Health endpoints: `GET /health/live` (Postgres + agentOS sidecar), `GET /health` (Postgres + Discord ready + agentOS sidecar).

### Secrets needed for the full task flow
- With a placeholder `DISCORD_BOT_TOKEN`, the process boots, runs DB migrations, then exits:
  `discord.js` throws `TokenInvalid` and the unhandled rejection terminates the process. This is
  expected without real credentials and still proves DB/config bootstrap works.
- To exercise `/task`, `/setup`, `/mcp` end-to-end you need real values for `DISCORD_BOT_TOKEN`,
  `GITHUB_TOKEN`, and at least one Pi provider API key (e.g. `ANTHROPIC_API_KEY` or
  `OPENCODE_API_KEY`, or `PI_MODELS_JSON` for custom providers). There is no standalone web UI;
  the interface is Discord.

### Lint / test / build
- Standard scripts in `package.json`: `npm run check` (typecheck), `npm test` (vitest), `npm run build`.
- Unit tests mock Postgres, so `npm test` does not require a running database.
