import type { Pool } from "pg";
import { Pool as PgPool } from "pg";

let poolInstance: Pool | undefined;

export interface PostgresQuery {
  (text: string, params?: unknown[]): Promise<unknown[]>;
}

export function initializeDatabase(databaseUrl: string): Pool {
  if (!poolInstance) {
    poolInstance = new PgPool({ connectionString: databaseUrl });
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
    transaction: async <T>(fn: (tx: { query: PostgresQuery }) => Promise<T>) => {
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

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  },
});
