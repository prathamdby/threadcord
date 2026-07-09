/** A single definition or reference extracted from a source file. */
export type TagKind = "def" | "ref";

export interface Tag {
  relPath: string;
  name: string;
  kind: TagKind;
  /** 1-based line of the symbol name (or definition start). */
  line: number;
  /** First source line of the enclosing definition (signature-ish). */
  signature: string;
  /** Definition category for ranking/display. */
  category: TagCategory;
}

export type TagCategory =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "module"
  | "const"
  | "macro"
  | "other";

export interface RankedFile {
  relPath: string;
  score: number;
  defs: Tag[];
}

export interface RepoMapOptions {
  /** Absolute path to the repository root (or checkout cwd). */
  root: string;
  /** Optional subpath relative to root to scope the scan. */
  path?: string;
  /** Already-known files (absolute or root-relative); boost ranking, excluded from map. */
  focusFiles?: string[];
  /** Identifiers to boost (e.g. function names mentioned in the task). */
  priorityIdents?: string[];
  /** Soft character budget for the rendered map (default 12000). */
  maxChars?: number;
  /** Max source files to parse (default 400). */
  maxFiles?: number;
  /** Max file size in bytes to parse (default 256_000). */
  maxFileBytes?: number;
}

export interface RepoMapResult {
  map: string;
  filesScanned: number;
  filesMapped: number;
  defsShown: number;
  truncated: boolean;
}
