import type { PoolClient } from "pg";
import type { Db } from "pg-boss";

export function pgBossDb(client: PoolClient): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) =>
      client.query(text, values),
  };
}