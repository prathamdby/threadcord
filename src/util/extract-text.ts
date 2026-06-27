/**
 * Extract text from a Flue content-array result shape.
 *
 * Flue tool errors can return results as `{ content: [{ type: "text", text: "..." }] }`.
 * This helper pulls the text out of that structure.
 */
export function extractContentArrayText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== undefined && b.type !== "text") continue;
    if (typeof b.text !== "string" || b.text.trim().length === 0) continue;
    texts.push(b.text.trim());
  }
  return texts.length > 0 ? texts.join("\n").trim() : undefined;
}
