import { describe, expect, it } from "vitest";
import { shortenPathForPreview } from "../src/discord/tool-preview-path.js";
import { buildToolPreview, formatToolLine } from "../src/discord/tool-format.js";

describe("shortenPathForPreview", () => {
  const repoRoot = "/workspaces/task-uuid/threadcord";

  it("returns repo-relative paths when repo root is known", () => {
    expect(
      shortenPathForPreview(
        "/workspaces/task-uuid/threadcord/src/discord/tool-format.ts",
        repoRoot,
      ),
    ).toBe("src/discord/tool-format.ts");
  });

  it("leaves short relative paths unchanged", () => {
    expect(shortenPathForPreview("src/main.py", repoRoot)).toBe("src/main.py");
  });

  it("strips /workspaces/<id>/<repo>/ without repo root", () => {
    expect(
      shortenPathForPreview(
        "/workspaces/cdbc2777/threadcord/src/discord/tool-format.ts",
      ),
    ).toBe("src/discord/tool-format.ts");
  });

  it("strips /root/workspace/.../repo/ without repo root", () => {
    expect(
      shortenPathForPreview(
        "/root/workspace/foo/bar/threadcord/src/discord/tool-format.ts",
      ),
    ).toBe("src/discord/tool-format.ts");
  });
});

describe("formatToolLine path shortening", () => {
  const repoRoot = "/workspaces/task-uuid/threadcord";

  it("shortens absolute paths in read previews", () => {
    expect(
      formatToolLine(
        "read",
        {
          path: "/workspaces/task-uuid/threadcord/src/discord/tool-format.ts",
        },
        { repoRoot },
      ),
    ).toBe('📖 read: "src/discord/tool-format.ts"');
  });

  it("does not shorten grep pattern previews", () => {
    expect(
      buildToolPreview("grep", { pattern: "/workspaces/foo/bar" }),
    ).toBe("/workspaces/foo/bar");
  });

  it("shortens workspace paths inside bash commands", () => {
    const repoRoot = "/workspaces/task-uuid/threadcord";
    expect(
      formatToolLine(
        "bash",
        {
          command:
            "cd /workspaces/task-uuid/threadcord && npm test",
        },
        { repoRoot },
      ),
    ).toBe('💻 bash\n```\ncd . && npm test\n```');
  });

  it("shortens edit tool path via first string field", () => {
    const repoRoot = "/workspaces/task-uuid/threadcord";
    expect(
      formatToolLine(
        "edit",
        { path: "/workspaces/task-uuid/threadcord/src/app.ts" },
        { repoRoot },
      ),
    ).toBe('🔧 edit: "src/app.ts"');
  });
});