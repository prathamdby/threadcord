# AGENTS.md

## Cursor Cloud specific instructions

Threadcord is a single Node/TypeScript service: a Discord bot + small Hono HTTP server
that runs Flue coding-agent tasks. See `README.md` for the product overview and the full
list of commands; this section only records non-obvious cloud-environment caveats.

### Node version (important)
- Flue requires Node `>=22.18`. The base image's `/exec-daemon/node` is `22.14`, which makes
  `npm run build` and `npm run dev` fail with "Node.js v22.14.0 is not supported by Flue".
- The required version (`v22.22.2`) is installed via nvm and `~/.bashrc` is configured to put it
  first on `PATH`, so interactive agent shells get it automatically (`node --version` → `v22.22.2`).
- If a shell ever shows `22.14`, run: `export PATH="$NVM_DIR/versions/node/v22.22.2/bin:$PATH"`.
- `npm install` works on either Node version (the engine mismatch is only a warning).

### PostgreSQL (required service, not in the update script)
- The app needs Postgres; `DATABASE_URL` is mandatory. A local cluster (PostgreSQL 16, cluster
  `main`) is provisioned with db/user/password all `threadcord`, matching the `.env` default.
- Start it if not running: `sudo pg_ctlcluster 16 main start`
- Quick check: `PGPASSWORD=threadcord psql -h localhost -U threadcord -d threadcord -c '\dt'`
- On boot the app runs `store.migrate()` / `setupStore.migrate()` / `mcpStore.migrate()`, creating
  ~19 tables (`tasks`, `setup_profiles`, `mcp_servers`, `flue_*`, …). Migrations are idempotent.

### Running the app
- Dev: `npm run dev` (Flue dev server on port `3583`). Flue/Vite loads `.env` automatically.
- `node dist/server.mjs` (`npm start`) does NOT load `.env` — it reads the real process env, so
  export the variables (or use the Docker/compose path) when running the built server directly.
- `.env` is gitignored. A local dev `.env` exists with placeholder Discord/GitHub/provider values.
- Health endpoints: `GET /health/live` (Postgres only), `GET /health` (Postgres + Discord ready).

### Secrets needed for the full task flow
- With a placeholder `DISCORD_BOT_TOKEN`, the process boots, runs DB migrations, then exits:
  `discord.js` throws `TokenInvalid` and the unhandled rejection terminates the process. This is
  expected without real credentials and still proves DB/config bootstrap works.
- To exercise `/task`, `/setup`, `/mcp` end-to-end you need real values for `DISCORD_BOT_TOKEN`,
  `GITHUB_TOKEN`, and at least one LLM provider (`ANTHROPIC_API_KEY` + `ANTHROPIC_MODELS`, or
  `OPENAI_API_KEY` + `OPENAI_MODELS`). There is no standalone web UI; the interface is Discord.

### Lint / test / build
- Standard scripts in `package.json`: `npm run check` (typecheck), `npm test` (vitest), `npm run build`.
- Unit tests mock Postgres, so `npm test` does not require a running database.
