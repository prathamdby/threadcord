import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";
import { GRAMMAR_SPECS, type GrammarId } from "./languages.js";
import type { Tag, TagCategory } from "./types.js";

let initPromise: Promise<void> | undefined;
const languageCache = new Map<GrammarId, Language>();

/** Resolve vendor/tree-sitter (cwd first, then relative to this module). */
export function resolveWasmDir(): string {
  const candidates = [
    join(process.cwd(), "vendor", "tree-sitter"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "tree-sitter"),
    join(dirname(fileURLToPath(import.meta.url)), "vendor", "tree-sitter"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "tree-sitter-typescript.wasm"))) {
      return dir;
    }
  }
  return candidates[0]!;
}

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init().then(() => undefined);
  }
  await initPromise;
}

export async function loadLanguage(
  id: GrammarId,
  /** Test override for the WASM directory (production callers omit this). */
  wasmDir?: string,
): Promise<Language> {
  const cacheKey = id;
  if (!wasmDir) {
    const cached = languageCache.get(cacheKey);
    if (cached) return cached;
  }
  await ensureInit();
  const spec = GRAMMAR_SPECS[id];
  const dir = wasmDir ?? resolveWasmDir();
  const wasmPath = join(dir, spec.wasm);
  if (!existsSync(wasmPath)) {
    throw new Error(
      `Missing tree-sitter WASM for ${id} at ${wasmPath}. Ensure vendor/tree-sitter is present.`,
    );
  }
  const lang = await Language.load(wasmPath);
  if (!wasmDir) languageCache.set(cacheKey, lang);
  return lang;
}

/** Test helper: drop cached languages (does not unload WASM). */
export function clearLanguageCache(): void {
  languageCache.clear();
}

interface DefRule {
  type: string;
  /** Field that holds the symbol name, or a custom extractor. */
  nameField?: string;
  category: TagCategory;
  /** Only treat as def when this predicate passes. */
  when?: (node: TsNode) => boolean;
  /** Custom name extraction when nameField is insufficient. */
  nameOf?: (node: TsNode) => string | undefined;
  /** Custom signature (defaults to first non-empty source line). */
  signatureOf?: (node: TsNode, source: string) => string;
}

const TS_LIKE_RULES: DefRule[] = [
  { type: "function_declaration", nameField: "name", category: "function" },
  {
    type: "generator_function_declaration",
    nameField: "name",
    category: "function",
  },
  { type: "class_declaration", nameField: "name", category: "class" },
  {
    type: "abstract_class_declaration",
    nameField: "name",
    category: "class",
  },
  { type: "interface_declaration", nameField: "name", category: "interface" },
  { type: "type_alias_declaration", nameField: "name", category: "type" },
  { type: "enum_declaration", nameField: "name", category: "enum" },
  { type: "method_definition", nameField: "name", category: "method" },
  {
    type: "public_field_definition",
    nameField: "name",
    category: "const",
    when: (node) => {
      const value = node.childForFieldName("value");
      return (
        value?.type === "arrow_function" ||
        value?.type === "function_expression" ||
        value?.type === "function"
      );
    },
  },
  {
    type: "lexical_declaration",
    category: "const",
    nameOf: (node) => {
      const declarator = node.namedChildren.find(
        (c) => c.type === "variable_declarator",
      );
      if (!declarator) return undefined;
      const nameNode = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier") return undefined;
      const isFn =
        value?.type === "arrow_function" ||
        value?.type === "function_expression" ||
        value?.type === "function" ||
        value?.type === "generator_function";
      const exported = node.parent?.type === "export_statement";
      if (!isFn && !exported) return undefined;
      return nameNode.text;
    },
    signatureOf: (node, source) => firstLine(source, node),
  },
];

const PYTHON_RULES: DefRule[] = [
  { type: "function_definition", nameField: "name", category: "function" },
  { type: "class_definition", nameField: "name", category: "class" },
];

const GO_RULES: DefRule[] = [
  { type: "function_declaration", nameField: "name", category: "function" },
  { type: "method_declaration", nameField: "name", category: "method" },
  {
    type: "type_spec",
    nameField: "name",
    category: "type",
  },
  {
    type: "type_declaration",
    category: "type",
    nameOf: (node) => {
      const spec = node.namedChildren.find((c) => c.type === "type_spec");
      return spec?.childForFieldName("name")?.text;
    },
  },
];

const RUST_RULES: DefRule[] = [
  { type: "function_item", nameField: "name", category: "function" },
  { type: "struct_item", nameField: "name", category: "class" },
  { type: "enum_item", nameField: "name", category: "enum" },
  { type: "trait_item", nameField: "name", category: "interface" },
  { type: "type_item", nameField: "name", category: "type" },
  { type: "mod_item", nameField: "name", category: "module" },
  { type: "macro_definition", nameField: "name", category: "macro" },
  { type: "impl_item", category: "class", nameOf: rustImplName },
];

function rustImplName(node: TsNode): string | undefined {
  // impl Foo { ... } or impl Trait for Foo
  const type = node.childForFieldName("type");
  const trait = node.childForFieldName("trait");
  if (trait && type) return `${trait.text} for ${type.text}`;
  return type?.text;
}

const RULES: Record<GrammarId, DefRule[]> = {
  typescript: TS_LIKE_RULES,
  tsx: TS_LIKE_RULES,
  javascript: TS_LIKE_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
};

/** Node types treated as identifier references (for ranking edges). */
const REF_TYPES = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "field_identifier",
  "shorthand_property_identifier",
]);

function firstLine(source: string, node: TsNode): string {
  const start = node.startIndex;
  const slice = source.slice(start, Math.min(source.length, start + 200));
  const line = slice.split(/\r?\n/, 1)[0] ?? "";
  return line.trim().slice(0, 160);
}

function isInsideDefName(node: TsNode, defNameNodes: Set<TsNode>): boolean {
  let cur: TsNode | null = node;
  while (cur) {
    if (defNameNodes.has(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Parse one source file and return definition + reference tags.
 * References are identifier names only (used for the ranking graph).
 */
export async function extractTags(
  absPath: string,
  relPath: string,
  grammar: GrammarId,
  source?: string,
): Promise<Tag[]> {
  const text = source ?? readFileSync(absPath, "utf8");
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  let tree;
  try {
    tree = parser.parse(text);
  } finally {
    parser.delete();
  }
  if (!tree) return [];

  const tags: Tag[] = [];
  const defNameNodes = new Set<TsNode>();
  const rules = RULES[grammar];

  function visit(node: TsNode): void {
    for (const rule of rules) {
      if (node.type !== rule.type) continue;
      if (rule.when && !rule.when(node)) continue;
      let name: string | undefined;
      let nameNode: TsNode | null = null;
      if (rule.nameOf) {
        name = rule.nameOf(node);
      } else if (rule.nameField) {
        nameNode = node.childForFieldName(rule.nameField);
        name = nameNode?.text;
      }
      if (!name || name.length === 0) continue;
          if (name === "default") continue;
      if (nameNode) defNameNodes.add(nameNode);
      const signature = rule.signatureOf
        ? rule.signatureOf(node, text)
        : firstLine(text, node);
      tags.push({
        relPath,
        name,
        kind: "def",
        line: node.startPosition.row + 1,
        signature,
        category: rule.category,
      });
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  function visitRefs(node: TsNode): void {
    if (REF_TYPES.has(node.type)) {
      const name = node.text;
      if (
        name &&
        name.length > 1 &&
        !isInsideDefName(node, defNameNodes) &&
        /^[A-Za-z_$][\w$]*$/.test(name)
      ) {
        tags.push({
          relPath,
          name,
          kind: "ref",
          line: node.startPosition.row + 1,
          signature: "",
          category: "other",
        });
      }
    }
    for (const child of node.children) {
      visitRefs(child);
    }
  }
  visitRefs(tree.rootNode);

  tree.delete();
  return tags;
}

/**
 * Normalize a focus/priority path to a root-relative posix path.
 * Uses path.relative so sibling prefixes like `/app` vs `/application` never collide.
 * Paths outside the root (including `..` escapes) are returned unchanged so callers
 * can detect a non-match against scanned files.
 */
export function toRelPath(root: string, path: string): string {
  if (!path) return path;
  const absRoot = pathResolve(root);
  const abs = pathResolve(isAbsolute(path) ? path : join(root, path));
  const rel = relative(absRoot, abs);
  // Outside root: relative is absolute or walks up with `..`.
  if (!rel || rel === "") return ".";
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(".." + "/") ||
    rel.startsWith(".." + "\\")
  ) {
    return path;
  }
  return rel.split("\\").join("/");
}
