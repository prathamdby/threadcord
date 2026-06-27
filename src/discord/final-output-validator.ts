/**
 * Validates that a final Discord output (post_thread_message or
 * post_thread_report part) has useful structure and substance.
 *
 * Rules:
 * - Must contain at least one `##` Markdown header.
 * - At least one section must have substantive body text (not just a label,
 *   bold text, or a single word like "Done.").
 * - Thin outputs like "## Summary\nDone." are rejected.
 */

const MIN_HEADER_COUNT = 1;
const MIN_SECTION_BODY_CHARS = 20;

/**
 * Returns an error message if the content is too thin, or undefined if valid.
 */
export function validateFinalOutput(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return "Final output is empty. Expand with concrete facts from the turn: what was read, changed, verified, or concluded.";
  }

  // Count ## headers (but not ### or deeper — those are subsections).
  const headerMatches = trimmed.match(/^##\s+\S/gm);
  if (!headerMatches || headerMatches.length < MIN_HEADER_COUNT) {
    return "Final output must contain at least one ## section header. Structure your response with sections like ## Summary, ## Changes, ## Verification, ## Root cause, etc.";
  }

  // Check that at least one section has substantive body text.
  const sections = splitByHeaders(trimmed);
  const hasSubstantiveSection = sections.some(
    (section) =>
      /^##\s+\S/.test(section.header) &&
      countBodyChars(section.body) >= MIN_SECTION_BODY_CHARS,
  );

  if (!hasSubstantiveSection) {
    return "Final output sections must contain substantive body text (at least 20 chars of concrete detail per section). Expand with what was done, files changed, commands run, or conclusions reached. Do not post placeholder labels.";
  }

  return undefined;
}

interface Section {
  header: string;
  body: string;
}

function splitByHeaders(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      if (current) sections.push(current);
      current = { header: line, body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else {
      // Content before any header — treat as a section with empty header.
      current = { header: "", body: line };
    }
  }
  if (current) sections.push(current);
  return sections;
}

function countBodyChars(body: string): number {
  // Remove headers, code fences, links, bold markers, and whitespace
  // to count actual content characters.
  const cleaned = body
    .replace(/^###?\s+.*$/gm, "") // sub-headers
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")) // keep code content
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/\*\*/g, "") // bold
    .replace(/`/g, "") // inline code
    .replace(/^>\s*/gm, "") // blockquotes
    .replace(/^[-*]\s*/gm, "") // list markers
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length;
}
