const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/g,
  /(api[_-]?key|token|authorization|password)\s*[:=]\s*['"]?[^'"\s]+/gi
];

export function redact(value: string): string {
  return TOKEN_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), value);
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
