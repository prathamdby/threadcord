# Backup and Restore

Threadcord keeps durable state in two places: a PostgreSQL database and a host workspace volume. Backing up both is required to survive a host or VPS rebuild without losing task history, setup profiles, or in-flight agent work.

## What to back up

1. **PostgreSQL database** — stores task metadata, setup profiles, Discord message ids, agent session/turn/event logs, and MCP server configuration.
2. **Workspace volume** — the directory tree on the host that contains cloned repositories, agent file edits, and build artifacts for each task. The default host path is `/workspaces` (configurable via `WORKSPACE_ROOT`).

## PostgreSQL backup

Use `pg_dump` to create a logical backup. Run the command from any host that can reach the database.

```bash
# Replace with your actual DATABASE_URL credentials.
export DATABASE_URL="YOUR_DATABASE_URL_HERE"

pg_dump -Fc --no-owner --no-acl \
  -d "$DATABASE_URL" \
  > threadcord-$(date +%Y%m%d-%H%M%S).dump
```

- `-Fc` writes a custom-format archive that is compact and supports selective restore.
- `--no-owner` and `--no-acl` make the dump portable across different Postgres users/roles.
- Store the resulting `.dump` file outside the host, for example on object storage or another machine.

### Restore Postgres

```bash
# Create the database first if it does not exist.
createdb -h localhost -U threadcord threadcord

# Restore the schema and data.
pg_restore -d "$DATABASE_URL" --clean --if-exists threadcord-YYYYMMDD-HHMMSS.dump
```

## Workspace volume backup

The workspace volume is plain filesystem data. Use any file-level or block-level backup strategy that fits your hosting environment.

### File-level backup (rsync)

```bash
rsync -aP --delete /workspaces/ backup-host:/backups/threadcord/workspaces/
```

### Block-level backup (if using a Docker volume or LVM/ZFS)

- Docker: use `docker run --rm -v threadcord_workspaces:/workspaces -v $(pwd):/backup alpine tar czf /backup/workspaces.tar.gz -C /workspaces .`
- ZFS: `zfs snapshot pool/threadcord-workspaces@<timestamp>` and replicate with `zfs send`.
- LVM: create a snapshot with `lvcreate -s` and copy the data from the snapshot.

### Restore workspace volume

1. Stop the Threadcord container or process so no agent is actively writing to the workspace.
2. Restore the files to the configured `WORKSPACE_ROOT` (default `/workspaces`).
3. Ensure file ownership and permissions match the user that runs the Threadcord process.
4. Start Threadcord again.

## Backup cadence and retention

- **Database:** back up before any migration or deployment, and at least daily for production. Keep retention aligned with your recovery-point objective.
- **Workspaces:** back up after any completed task or at least daily. In-flight workspaces change during agent turns; a backup taken mid-turn may contain partially edited state, which is acceptable because the event log in Postgres remains the canonical conversation state.

## Restoring after a rebuild

1. Provision the new host with the same `WORKSPACE_ROOT` and `DATABASE_URL` configuration.
2. Restore the Postgres dump first; Threadcord migrations are idempotent, so they will create any missing tables after the restore.
3. Restore the workspace volume to the same `WORKSPACE_ROOT` path.
4. Start Threadcord. On boot it will run `store.migrate()`, `setupStore.migrate()`, `mcpStore.migrate()`, and `agentTurnPersistence.migrate()` safely against the restored database.

## Important notes

- Secrets such as `DISCORD_BOT_TOKEN`, `GITHUB_TOKEN`, and API keys are not stored in Postgres or the workspace volume; they come from environment variables. Rebuild the environment separately.
- The Discord message ids stored in Postgres are stable, so status/header message edits continue to work as long as the messages still exist in Discord. If a Discord channel/thread was deleted, those message ids are no longer usable and the task will post fresh messages on the next turn.
- Do not back up `node_modules` or the `dist` build directory; they can be rebuilt with `npm install` and `npm run build`.
