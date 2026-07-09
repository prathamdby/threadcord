import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/repomap/build.js";
import { discoverSourceFiles } from "../src/repomap/discover.js";
import { extractTags } from "../src/repomap/parser.js";
import { rankFiles } from "../src/repomap/rank.js";
import { createRepoMapTools, REPO_MAP_DESCRIPTION } from "../src/repomap/tool.js";
import type { Tag } from "../src/repomap/types.js";

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

  it("rejects paths that escape the root", () => {
    root = makeRepo({ "a.ts": "export function a() {}" });
    expect(() => discoverSourceFiles(root, { path: ".." })).toThrow(
      /within the repository root/,
    );
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
    const tags = await extractTags("/virtual/a.ts", "a.ts", "typescript", source);
    const defs = tags.filter((t) => t.kind === "def");
    const defNames = defs.map((d) => d.name).sort();
    expect(defNames).toEqual(
      expect.arrayContaining(["foo", "Bar", "method", "IFace", "Alias", "named", "helper"]),
    );
    expect(defNames).not.toContain("localOnly");
    const refs = tags.filter((t) => t.kind === "ref").map((t) => t.name);
    expect(refs).toContain("bar");
    expect(refs).toContain("foo");
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
    expect(defs).toEqual(expect.arrayContaining(["Greeter", "hello", "top_level"]));
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
    const ranked = rankFiles({
      tags,
      focusFiles: new Set(["app.ts"]),
      priorityIdents: new Set(),
    });
    // focus file excluded; lib should rank above unused util
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
    const ranked = rankFiles({
      tags,
      focusFiles: new Set(),
      priorityIdents: new Set(["beta"]),
    });
    expect(ranked[0]?.relPath).toBe("b.ts");
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
  });

  it("respects maxChars budget", async () => {
    // Inflate the tree so the full map exceeds a tight budget.
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
