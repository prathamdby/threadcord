import * as v from "valibot";
import { defineResilientTool } from "../tools/resilient-tool.js";
import { buildRepoMap } from "./build.js";

export const REPO_MAP_DESCRIPTION = `Generate a ranked repository map of code definitions using tree-sitter ASTs (aider-style).

Use this early on an unfamiliar checkout or when you need structural orientation before grepping:

- Omit all optional fields for a whole-repo overview (top symbols fitted to a character budget).
- Pass \`path\` to scope the scan to a subdirectory or single file.
- Pass \`focusFiles\` for files you already read — they seed ranking and are excluded from the map so related code surfaces.
- Pass \`priorityIdents\` for symbol names from the task (function/class names) to boost their defining files.
- \`maxChars\` caps the rendered map (default 12000).

Returns a text map of \`path\` + signature lines (\`L<n> …\`). Prefer this over raw \`find\`/\`ls\` for codebase orientation.`;

export function createRepoMapTools(workspaceRoot: string) {
  return [
    defineResilientTool({
      name: "repo_map",
      description: REPO_MAP_DESCRIPTION,
      parameters: v.object({
        path: v.optional(v.pipe(v.string(), v.minLength(1))),
        focusFiles: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
        priorityIdents: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
        maxChars: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(100_000)),
        ),
      }),
      async execute(input) {
        const result = await buildRepoMap({
          root: workspaceRoot,
          ...(input.path ? { path: input.path } : {}),
          ...(input.focusFiles ? { focusFiles: input.focusFiles } : {}),
          ...(input.priorityIdents
            ? { priorityIdents: input.priorityIdents }
            : {}),
          ...(input.maxChars !== undefined
            ? { maxChars: input.maxChars }
            : {}),
        });
        if (result.warnings.length === 0) return result.map;
        return (
          result.map +
          "\n\nWarnings:\n" +
          result.warnings.map((w) => `- ${w}`).join("\n")
        );
      },
    }),
  ];
}

