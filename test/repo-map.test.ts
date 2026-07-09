import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/repomap/build.js";
import { discoverSourceFiles } from "../src/repomap/discover.js";
import {
  clearLanguageCache,
  extractTags,
  loadLanguage,
  toRelPath,
} from "../src/repomap/parser.js";
import { rankFiles } from "../src/repomap/rank.js";
import { renderRepoMap } from "../src/repomap/render.js";
import {
  createRepoMapTools,
  REPO_MAP_DESCRIPTION,
} from "../src/repomap/tool.js";
import type { RankedFile, Tag } from "../src/repomap/types.js";

function makeRepo(files: Record<string, string>): string {
  const root = join(
    tmpdir(),
    `threadcord-repomap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("createRepoMapTools", () => {
  it("registers a single tool named repo_map", () => {
    const tools = createRepoMapTools("/tmp/proj");
    expect(tools.map((t) => t.name)).toEqual(["repo_map"]);
    expect(REPO_MAP_DESCRIPTION).toContain("tree-sitter");
    expect(REPO_MAP_DESCRIPTION).toContain("focusFiles");
  });
});

describe("discoverSourceFiles", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("finds ts/js/py and skips node_modules and .d.ts", () => {
    root = makeRepo({
      "src/a.ts": "export function a() {}",
      "src/b.js": "export function b() {}",
      "src/c.py": "def c():\n  pass\n",
      "src/skip.d.ts": "export type X = string;",
      "node_modules/pkg/index.js": "export function hidden() {}",
      "dist/out.js": "export function built() {}",
    });
    const files = discoverSourceFiles(root);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual(["src/a.ts", "src/b.js", "src/c.py"]);
  });

  it("scopes to a subdirectory via path", () => {
    root = makeRepo({
      "src/a.ts": "export function a() {}",
      "lib/b.ts": "export function b() {}",
    });
    const files = discoverSourceFiles(root, { path: "src" });
    expect(files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
  });

  it("discovers a single supported file via path", () => {
    root = makeRepo({
      "src/a.ts": "export function a() {}",
      "src/b.ts": "export function b() {}",
    });
    const files = discoverSourceFiles(root, { path: "src/a.ts" });
    expect(files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
  });

  it("throws for unsupported single file", () => {
    root = makeRepo({
      "src/readme.md": "# hi",
    });
    expect(() => discoverSourceFiles(root, { path: "src/readme.md" })).toThrow(
      /Unsupported file type/,
    );
  });

  it("rejects paths that escape the root", () => {
    root = makeRepo({ "a.ts": "export function a() {}" });
    expect(() => discoverSourceFiles(root, { path: ".." })).toThrow(
      /within the repository root/,
    );
  });

  it("caps discovered files at maxFiles", () => {
    root = makeRepo({
      "a.ts": "export function a() {}",
      "b.ts": "export function b() {}",
      "c.ts": "export function c() {}",
      "d.ts": "export function d() {}",
      "e.ts": "export function e() {}",
    });
    expect(discoverSourceFiles(root, { maxFiles: 2 })).toHaveLength(2);
    expect(discoverSourceFiles(root, { maxFiles: 0 })).toHaveLength(0);
  });

  it("throws on nonexistent subpath", () => {
    root = makeRepo({ "a.ts": "export function a() {}" });
    expect(() =>
      discoverSourceFiles(root, { path: "nonexistent" }),
    ).toThrow(/does not exist/);
    try {
      discoverSourceFiles(root, { path: "nonexistent" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("nonexistent");
    }
  });
});

describe("extractTags (tree-sitter)", () => {
  it("extracts TS functions, classes, interfaces, types, and exported consts", async () => {
    const source = `
export function foo(a: string): number {
  return bar(a);
}
export class Bar {
  method(x: number) { return foo(String(x)); }
}
export interface IFace { x: string }
export type Alias = string
export const named = () => 1
const localOnly = 1
async function helper() { return foo("z"); }
`;
    const tags = await extractTags(
      "/virtual/a.ts",
      "a.ts",
      "typescript",
      source,
    );
    const defs = tags.filter((t) => t.kind === "def");
    const defNames = defs.map((d) => d.name).sort();
    expect(defNames).toEqual(
      expect.arrayContaining([
        "foo",
        "Bar",
        "method",
        "IFace",
        "Alias",
        "named",
        "helper",
      ]),
    );
    expect(defNames).not.toContain("localOnly");
    const refs = tags.filter((t) => t.kind === "ref").map((t) => t.name);
    expect(refs).toContain("bar");
    expect(refs).toContain("foo");
    // Single-letter identifiers are filtered out of refs.
    expect(refs).not.toContain("a");
    expect(refs).not.toContain("x");
  });

  it("does not dedupe repeated refs (documents current behavior)", async () => {
    const source = `
export function foo(x: number): number { return x; }
export function run() {
  foo(1);
  foo(2);
  foo(3);
}
`;
    const tags = await extractTags(
      "/virtual/a.ts",
      "a.ts",
      "typescript",
      source,
    );
    const fooRefs = tags.filter((t) => t.kind === "ref" && t.name === "foo");
    expect(fooRefs.length).toBeGreaterThanOrEqual(3);
  });

  it("extracts Python class and function defs", async () => {
    const source = `
class Greeter:
    def hello(self, name):
        return other(name)

def top_level():
    return Greeter()
`;
    const tags = await extractTags("/virtual/a.py", "a.py", "python", source);
    const defs = tags.filter((t) => t.kind === "def").map((t) => t.name);
    expect(defs).toEqual(
      expect.arrayContaining(["Greeter", "hello", "top_level"]),
    );
  });

  it("returns empty tags for empty or whitespace source", async () => {
    await expect(
      extractTags("/virtual/a.ts", "a.ts", "typescript", ""),
    ).resolves.toEqual([]);
    await expect(
      extractTags("/virtual/a.ts", "a.ts", "typescript", "   "),
    ).resolves.toEqual([]);
  });

  it("reloads language after clearLanguageCache", async () => {
    clearLanguageCache();
    const tags = await extractTags(
      "/virtual/a.ts",
      "a.ts",
      "typescript",
      "export function afterClear() { return 1; }\n",
    );
    expect(tags.some((t) => t.kind === "def" && t.name === "afterClear")).toBe(
      true,
    );
  });

  it("throws Missing tree-sitter WASM when grammar file is absent", async () => {
    clearLanguageCache();
    await expect(
      loadLanguage("typescript", "/tmp/threadcord-no-wasm-dir-for-test"),
    ).rejects.toThrow(/Missing tree-sitter WASM/);
  });

});

describe("toRelPath", () => {
  it("returns relative path for files under root", () => {
    expect(toRelPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(toRelPath("/repo", "src/a.ts")).toBe("src/a.ts");
  });

  it("does not treat sibling prefix paths as under root", () => {
    // path.relative based: /app must not match /application
    expect(toRelPath("/app", "/application/foo.ts")).toBe(
      "/application/foo.ts",
    );
  });

  it("returns raw path when outside the root", () => {
    expect(toRelPath("/repo", "/etc/passwd")).toBe("/etc/passwd");
    expect(toRelPath("/repo", "../../../etc")).toBe("../../../etc");
  });
});

describe("rankFiles", () => {
  it("ranks defining files higher when referenced from focus files", () => {
    const tags: Tag[] = [
      {
        relPath: "lib.ts",
        name: "core",
        kind: "def",
        line: 1,
        signature: "export function core()",
        category: "function",
      },
      {
        relPath: "app.ts",
        name: "core",
        kind: "ref",
        line: 2,
        signature: "",
        category: "other",
      },
      {
        relPath: "app.ts",
        name: "run",
        kind: "def",
        line: 1,
        signature: "export function run()",
        category: "function",
      },
      {
        relPath: "util.ts",
        name: "helper",
        kind: "def",
        line: 1,
        signature: "export function helper()",
        category: "function",
      },
    ];
    const { ranked } = rankFiles({
      tags,
      focusFiles: new Set(["app.ts"]),
      priorityIdents: new Set(),
    });
    expect(ranked.map((r) => r.relPath)).not.toContain("app.ts");
    expect(ranked[0]?.relPath).toBe("lib.ts");
  });

  it("boosts files defining priority idents", () => {
    const tags: Tag[] = [
      {
        relPath: "a.ts",
        name: "alpha",
        kind: "def",
        line: 1,
        signature: "function alpha()",
        category: "function",
      },
      {
        relPath: "b.ts",
        name: "beta",
        kind: "def",
        line: 1,
        signature: "function beta()",
        category: "function",
      },
    ];
    const { ranked } = rankFiles({
      tags,
      focusFiles: new Set(),
      priorityIdents: new Set(["beta"]),
    });
    expect(ranked[0]?.relPath).toBe("b.ts");
  });

  it("edges to every file defining a shared symbol name", () => {
    const tags: Tag[] = [
      {
        relPath: "one.ts",
        name: "helper",
        kind: "def",
        line: 1,
        signature: "export function helper()",
        category: "function",
      },
      {
        relPath: "two.ts",
        name: "helper",
        kind: "def",
        line: 1,
        signature: "export function helper()",
        category: "function",
      },
      {
        relPath: "user.ts",
        name: "helper",
        kind: "ref",
        line: 2,
        signature: "",
        category: "other",
      },
      {
        relPath: "user.ts",
        name: "run",
        kind: "def",
        line: 1,
        signature: "export function run()",
        category: "function",
      },
      {
        relPath: "lonely.ts",
        name: "lonely",
        kind: "def",
        line: 1,
        signature: "export function lonely()",
        category: "function",
      },
    ];
    const { ranked } = rankFiles({
      tags,
      focusFiles: new Set(["user.ts"]),
      priorityIdents: new Set(),
    });
    const paths = ranked.map((r) => r.relPath);
    expect(paths).toContain("one.ts");
    expect(paths).toContain("two.ts");
    // Both defining files should outrank the unused file.
    const lonelyIdx = paths.indexOf("lonely.ts");
    expect(paths.indexOf("one.ts")).toBeLessThan(lonelyIdx);
    expect(paths.indexOf("two.ts")).toBeLessThan(lonelyIdx);
  });

  it("preserves overloaded same-name defs in a file", () => {
    const tags: Tag[] = [
      {
        relPath: "over.ts",
        name: "foo",
        kind: "def",
        line: 1,
        signature: "export function foo(a: string)",
        category: "function",
      },
      {
        relPath: "over.ts",
        name: "foo",
        kind: "def",
        line: 4,
        signature: "export function foo(a: number)",
        category: "function",
      },
    ];
    const { ranked } = rankFiles({
      tags,
      focusFiles: new Set(),
      priorityIdents: new Set(),
    });
    const defs = ranked.find((r) => r.relPath === "over.ts")?.defs ?? [];
    expect(defs.filter((d) => d.name === "foo")).toHaveLength(2);
  });

  it("warns when focusFiles match nothing", () => {
    const tags: Tag[] = [
      {
        relPath: "a.ts",
        name: "alpha",
        kind: "def",
        line: 1,
        signature: "function alpha()",
        category: "function",
      },
    ];
    const { warnings } = rankFiles({
      tags,
      focusFiles: new Set(["missing.ts"]),
      priorityIdents: new Set(),
    });
    expect(warnings.some((w) => w.includes("focusFiles matched no"))).toBe(
      true,
    );
  });
});

describe("renderRepoMap", () => {
  it("reports no symbols and truncated based on filesScanned", () => {
    const emptyScanned = renderRepoMap([], { filesScanned: 5 });
    expect(emptyScanned.map).toContain("(no source symbols found)");
    expect(emptyScanned.truncated).toBe(true);

    const emptyZero = renderRepoMap([], { filesScanned: 0 });
    expect(emptyZero.map).toContain("(no source symbols found)");
    expect(emptyZero.truncated).toBe(false);
  });

  it("renders empty-defs file as (no definitions)", () => {
    const ranked: RankedFile[] = [
      { relPath: "empty.ts", score: 1, defs: [] },
    ];
    const result = renderRepoMap(ranked, { filesScanned: 1, maxChars: 8000 });
    expect(result.map).toContain("empty.ts");
    expect(result.map).toContain("(no definitions)");
  });
});

describe("buildRepoMap integration", () => {
  let root: string;
  beforeEach(() => {
    root = makeRepo({
      "src/core.ts": `
export function core(x: number): number {
  return x + 1;
}
export class Engine {
  run() { return core(1); }
}
`,
      "src/app.ts": `
import { core, Engine } from "./core.js";
export function main() {
  const e = new Engine();
  return core(e.run());
}
`,
      "src/unused.ts": `
export function lonely() { return 0; }
`,
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a map containing key definitions", async () => {
    const result = await buildRepoMap({ root, maxChars: 8000 });
    expect(result.filesScanned).toBe(3);
    expect(result.map).toContain("src/core.ts");
    expect(result.map).toMatch(/function core|class Engine/);
    expect(result.defsShown).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it("respects maxChars budget", async () => {
    const bigRoot = makeRepo(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `src/mod${i}.ts`,
          `export function fn${i}(x: number): number { return x + ${i}; }\nexport class C${i} { m() { return fn${i}(1); } }\n`,
        ]),
      ),
    );
    try {
      const full = await buildRepoMap({ root: bigRoot, maxChars: 50_000 });
      const result = await buildRepoMap({ root: bigRoot, maxChars: 400 });
      expect(full.map.length).toBeGreaterThan(400);
      expect(result.map.length).toBeLessThanOrEqual(450);
      expect(result.map.length).toBeLessThan(full.map.length);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(bigRoot, { recursive: true, force: true });
    }
  });

  it("excludes focusFiles and surfaces related defs", async () => {
    const result = await buildRepoMap({
      root,
      focusFiles: ["src/app.ts"],
      maxChars: 8000,
    });
    expect(result.map).not.toMatch(/^src\/app\.ts$/m);
    expect(result.map).toContain("src/core.ts");
  });

  it("tool execute returns the map string", async () => {
    const tools = createRepoMapTools(root);
    const tool = tools[0]!;
    const out = await tool.execute({ maxChars: 8000 } as never);
    expect(typeof out).toBe("string");
    expect(out).toContain("Repository map");
    expect(out).toContain("src/");
  });
});
