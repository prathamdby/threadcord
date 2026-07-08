import { describe, expect, it } from "vitest";
import { createSetupTools } from "../src/setup/tools.js";

describe("createSetupTools", () => {
  it("throws structured validation error when install is empty", async () => {
    const tools = createSetupTools("run-1");
    const tool = tools.find((t) => t.name === "save_threadcord_setup_profile");
    expect(tool).toBeDefined();

    await expect(
      tool!.execute({
        environment: { install: "" },
        memoryMarkdown: "setup notes",
      } as never),
    ).rejects.toThrow(
      /save_threadcord_setup_profile validation failed:[\s\S]*Environment install command is required\.[\s\S]*Do not resend the same payload\./,
    );
  });
});
