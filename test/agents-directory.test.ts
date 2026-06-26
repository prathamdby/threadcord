import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const agentsDir = join(import.meta.dirname, "..", "src", "agents");
const agentFiles = readdirSync(agentsDir, { withFileTypes: true })
  .filter(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.endsWith(".ts") &&
      !dirent.name.endsWith(".d.ts"),
  )
  .map((dirent) => dirent.name);

describe("src/agents direct children are flue agents", () => {
  it.each(agentFiles.map((file) => [file.replace(/\.ts$/, ""), file]))(
    'agent "%s" default-exports a created agent',
    async (_name, file) => {
      const mod = await import(pathToFileURL(join(agentsDir, file)).href);
      expect(
        mod.default?.__flueCreatedAgent,
        `${file} must default-export createAgent(...); move non-agent helpers into a subdirectory`,
      ).toBe(true);
    },
  );
});
