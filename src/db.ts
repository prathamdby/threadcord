import { postgres, type PostgresQuery } from "@flue/postgres";
import type { PersistenceAdapter } from "@flue/runtime/internal";
import type { Pool } from "pg";
import { Pool as PgPool } from "pg";
import { registerFlueExecutionStore } from "./flue/agent-work-abort.js";

let poolInstance: Pool | undefined;
let flueAdapter: ReturnType<typeof createFluePostgres> | undefined;
let persistenceAdapter: PersistenceAdapter | undefined;

export function initializeDatabase(databaseUrl: string): Pool {
  if (!poolInstance) {
    poolInstance = new PgPool({ connectionString: databaseUrl });
    flueAdapter = createFluePostgres(poolInstance);
  }
  return poolInstance;
}

export function getPool(): Pool {
  if (!poolInstance) {
    if (process.env.DATABASE_URL) {
      return initializeDatabase(process.env.DATABASE_URL);
    }
    throw new Error(
      "Database pool not initialized. Call initializeDatabase() during application bootstrap.",
    );
  }
  return poolInstance;
}

export function createPostgresRunner(pool: Pool) {
  return {
    query: async (text: string, params?: unknown[]) =>
      (await pool.query(text, params)).rows,
    transaction: async <T>(
      fn: (tx: { query: PostgresQuery }) => Promise<T>,
    ) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let chain: Promise<unknown> = Promise.resolve();
        const query: PostgresQuery = (text, params) => {
          const run = chain
            .then(() => client.query(text, params))
            .then((result) => result.rows);
          chain = run.catch(() => {});
          return run;
        };
        const result = await fn({ query });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function createFluePostgres(pool: Pool) {
  return postgres(createPostgresRunner(pool));
}

function fluePersistenceBase(): ReturnType<typeof createFluePostgres> {
  if (!flueAdapter) {
    flueAdapter = createFluePostgres(getPool());
  }
  return flueAdapter;
}

function threadcordPersistenceAdapter(): PersistenceAdapter {
  if (persistenceAdapter) return persistenceAdapter;
  let base: ReturnType<typeof createFluePostgres> | undefined;
  persistenceAdapter = {
    async migrate() {
      base ??= fluePersistenceBase();
      if (base.migrate) await base.migrate();
    },
    async connect() {
      base ??= fluePersistenceBase();
      const stores = await base.connect();
      registerFlueExecutionStore(stores.executionStore);
      return stores;
    },
    async close() {
      // Pool lifecycle is owned by app bootstrap/shutdown (shared with TaskStore).
    },
  };
  return persistenceAdapter;
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  },
});

export default threadcordPersistenceAdapter();
