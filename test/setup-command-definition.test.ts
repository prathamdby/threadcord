import { describe, expect, it } from "vitest";
import type { APIApplicationCommandSubcommandOption } from "discord.js";
import { buildSetupCommandJson } from "../src/setup/command-definition.js";

function subcommandOptions(
  name: string,
): APIApplicationCommandSubcommandOption["options"] {
  const json = buildSetupCommandJson();
  const subcommand = json.options?.find(
    (option): option is APIApplicationCommandSubcommandOption =>
      option.type === 1 && option.name === name,
  );
  return subcommand?.options ?? [];
}

describe("setup command definition", () => {
  it("does not require repo/branch on profile-picker subcommands", () => {
    for (const name of ["status", "view", "edit", "export", "delete"]) {
      expect(subcommandOptions(name)).toEqual([]);
    }
  });

  it("keeps repo/branch and attachments on import", () => {
    expect(subcommandOptions("import")?.map((option) => option.name)).toEqual([
      "repo",
      "branch",
      "environment",
      "memory",
    ]);
  });
});
