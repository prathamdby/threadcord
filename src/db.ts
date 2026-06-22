import { postgres, type PostgresQuery } from '@flue/postgres';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';

let poolInstance: Pool | undefined;
let flueAdapter: ReturnType<typeof createFluePostgres> | undefined;

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
    throw new Error('Database pool not initialized. Call initializeDatabase() during application bootstrap.');
  }
  return poolInstance;
}

function createFluePostgres(pool: Pool) {
  return postgres({
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: async <T>(fn: (tx: { query: PostgresQuery }) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, params) => (await client.query(text, params)).rows
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  });
}

export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  }
});

export default new Proxy({} as ReturnType<typeof createFluePostgres>, {
  get(_target, prop, receiver) {
    if (!flueAdapter) {
      getPool();
    }
    if (!flueAdapter) {
      throw new Error('Flue postgres adapter not initialized');
    }
    return Reflect.get(flueAdapter, prop, receiver);
  }
});
