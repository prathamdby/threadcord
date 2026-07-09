import { extname } from "node:path";

export type GrammarId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust";

export interface LanguageSpec {
  id: GrammarId;
  /** WASM filename under vendor/tree-sitter/. */
  wasm: string;
}

const EXT_TO_GRAMMAR: Record<string, GrammarId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

export const GRAMMAR_SPECS: Record<GrammarId, LanguageSpec> = {
  typescript: { id: "typescript", wasm: "tree-sitter-typescript.wasm" },
  tsx: { id: "tsx", wasm: "tree-sitter-tsx.wasm" },
  javascript: { id: "javascript", wasm: "tree-sitter-javascript.wasm" },
  python: { id: "python", wasm: "tree-sitter-python.wasm" },
  go: { id: "go", wasm: "tree-sitter-go.wasm" },
  rust: { id: "rust", wasm: "tree-sitter-rust.wasm" },
};

export function grammarForPath(filePath: string): GrammarId | undefined {
  return EXT_TO_GRAMMAR[extname(filePath).toLowerCase()];
}

/** Directory / file name basenames always skipped while walking. */
export const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  ".threadcord",
  ".agents",
  ".pi",
  ".tabnine",
]);

/** Basename patterns skipped even outside skip dirs. */
export function shouldSkipFile(fileName: string): boolean {
  if (fileName.startsWith(".")) return true;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return true;
  if (fileName.endsWith(".d.ts")) return true;
  if (fileName.endsWith(".map")) return true;
  if (fileName.endsWith(".lock")) return true;
  return false;
}
