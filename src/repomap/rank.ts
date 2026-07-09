import type { RankedFile, Tag } from "./types.js";

export interface RankInput {
  /** All tags across the repo (defs + refs). */
  tags: Tag[];
  /** Root-relative paths of focus files (already known / being edited). */
  focusFiles: Set<string>;
  /** Identifier names to boost. */
  priorityIdents: Set<string>;
}

export interface RankOutput {
  ranked: RankedFile[];
  warnings: string[];
}

/**
 * Personalized PageRank over a file graph:
 * edge A → B when A references a symbol defined in B.
 * Focus files seed the personalization vector; priority idents boost their defining files.
 */
export function rankFiles(input: RankInput): RankOutput {
  const { tags, focusFiles, priorityIdents } = input;
  const warnings: string[] = [];

  const defsByName = new Map<string, Set<string>>();
  const defsByFile = new Map<string, Tag[]>();
  const files = new Set<string>();

  for (const tag of tags) {
    files.add(tag.relPath);
    if (tag.kind === "def") {
      let set = defsByName.get(tag.name);
      if (!set) {
        set = new Set();
        defsByName.set(tag.name, set);
      }
      set.add(tag.relPath);
      const list = defsByFile.get(tag.relPath) ?? [];
      list.push(tag);
      defsByFile.set(tag.relPath, list);
    }
  }

  const edges = new Map<string, Map<string, number>>();
  function addEdge(from: string, to: string, w: number): void {
    if (from === to) return;
    let row = edges.get(from);
    if (!row) {
      row = new Map();
      edges.set(from, row);
    }
    row.set(to, (row.get(to) ?? 0) + w);
  }

  for (const tag of tags) {
    if (tag.kind !== "ref") continue;
    const targets = defsByName.get(tag.name);
    if (!targets) continue;
    for (const to of targets) {
      const w = priorityIdents.has(tag.name) ? 10 : 1;
      addEdge(tag.relPath, to, w);
    }
  }

  const fileList = [...files];
  if (fileList.length === 0) return { ranked: [], warnings };

  const personal = new Map<string, number>();
  for (const f of fileList) personal.set(f, 0);
  let personalSum = 0;
  let matchedFocus = 0;
  for (const f of focusFiles) {
    if (personal.has(f)) {
      personal.set(f, (personal.get(f) ?? 0) + 20);
      personalSum += 20;
      matchedFocus += 1;
    }
  }
  if (focusFiles.size > 0 && matchedFocus === 0) {
    warnings.push(
      `focusFiles matched no scanned sources (${[...focusFiles].join(", ")}); using uniform ranking`,
    );
  }
  for (const ident of priorityIdents) {
    const defs = defsByName.get(ident);
    if (!defs) continue;
    for (const f of defs) {
      if (personal.has(f)) {
        personal.set(f, (personal.get(f) ?? 0) + 10);
        personalSum += 10;
      }
    }
  }
  if (personalSum === 0) {
    for (const f of fileList) personal.set(f, 1);
    personalSum = fileList.length;
  }
  for (const f of fileList) {
    personal.set(f, (personal.get(f) ?? 0) / personalSum);
  }

  const damping = 0.85;
  const scores = new Map<string, number>();
  for (const f of fileList) scores.set(f, 1 / fileList.length);

  const outWeight = new Map<string, number>();
  for (const f of fileList) {
    const row = edges.get(f);
    let sum = 0;
    if (row) for (const w of row.values()) sum += w;
    outWeight.set(f, sum);
  }

  const iterations = 20;
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const f of fileList) {
      next.set(f, (1 - damping) * (personal.get(f) ?? 0));
    }
    for (const from of fileList) {
      const row = edges.get(from);
      const ow = outWeight.get(from) ?? 0;
      const fromScore = scores.get(from) ?? 0;
      if (!row || ow === 0) {
        // Dangling nodes teleport via the personalization vector.
        for (const f of fileList) {
          next.set(
            f,
            (next.get(f) ?? 0) + damping * fromScore * (personal.get(f) ?? 0),
          );
        }
        continue;
      }
      for (const [to, w] of row) {
        next.set(to, (next.get(to) ?? 0) + damping * fromScore * (w / ow));
      }
    }
    for (const f of fileList) scores.set(f, next.get(f) ?? 0);
  }

  for (const ident of priorityIdents) {
    const defs = defsByName.get(ident);
    if (!defs) continue;
    for (const f of defs) {
      scores.set(f, (scores.get(f) ?? 0) + 0.05);
    }
  }

  const ranked: RankedFile[] = fileList.map((relPath) => {
    const defs = (defsByFile.get(relPath) ?? []).slice().sort((a, b) => {
      const cat = categoryWeight(b.category) - categoryWeight(a.category);
      if (cat !== 0) return cat;
      return a.line - b.line;
    });
    return {
      relPath,
      score: scores.get(relPath) ?? 0,
      defs,
    };
  });

  ranked.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

  return {
    ranked: ranked.filter((f) => !focusFiles.has(f.relPath)),
    warnings,
  };
}

function categoryWeight(cat: Tag["category"]): number {
  switch (cat) {
    case "class":
      return 6;
    case "interface":
      return 5;
    case "function":
      return 4;
    case "type":
      return 3;
    case "enum":
      return 3;
    case "method":
      return 2;
    case "module":
      return 2;
    case "const":
      return 1;
    case "macro":
      return 1;
    default:
      return 0;
  }
}
