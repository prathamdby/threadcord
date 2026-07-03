import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TaskStore } from "../src/task/store.js";

describe("TaskStore.migrate", () => {
  it("repairs legacy tasks schema including flue_instance_id", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      },
    } as unknown as Pool;

    const store = new TaskStore(pool, 3);
    await store.migrate();

    const joined = queries.join("\n");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS flue_instance_id");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS status_message_id");
    expect(joined).toContain("discord:thread:");
    expect(joined).toContain("legacy:' || id");
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_flue_instance_id_key",
    );
    expect(joined).toContain("ALTER COLUMN flue_instance_id SET NOT NULL");
  });
});