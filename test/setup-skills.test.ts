import { describe, expect, it } from "vitest";
import {
  buildSkillsInstallShellCommand,
  parseSkillLink,
  parseSkillLinksInput,
} from "../src/setup/skills.js";

describe("setup skills", () => {
  it("parses repo URL as install all skills", () => {
    expect(
      parseSkillLink("https://github.com/prathamdby/skills"),
    ).toEqual({
      packageArg: "https://github.com/prathamdby/skills",
      skillFlag: undefined,
    });
  });

  it("parses tree URL to single skill", () => {
    expect(
      parseSkillLink(
        "https://github.com/prathamdby/skills/tree/main/skills/commit",
      ),
    ).toEqual({
      packageArg: "prathamdby/skills",
      skillFlag: "commit",
    });
  });

  it("builds global skills add command", () => {
    const cmd = buildSkillsInstallShellCommand([
      "https://github.com/prathamdby/skills/tree/main/skills/commit",
    ]);
    expect(cmd).toContain("npx");
    expect(cmd).toContain("skills@latest");
    expect(cmd).toContain("add");
    expect(cmd).toContain("prathamdby/skills");
    expect(cmd).toContain("-g");
    expect(cmd).toContain("commit");
  });

  it("splits multiline skill input", () => {
    expect(parseSkillLinksInput("a\n\nb\n")).toEqual(["a", "b"]);
  });
});