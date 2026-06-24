// Discord is an untrusted display surface. Everything posted there, and every
// summarized error persisted alongside a task, runs through this sanitizer.
// Rules redact the secret value while keeping enough context (key name, URL
// host, the word Authorization) for an operator to still debug the failure.
// Order matters: each replacement inserts [redacted], which carries no secret
// characters, so later rules see already-sanitized text and the function is a
// fixed point (redact(redact(x)) === redact(x)). Add new shapes to RULES.

const REDACTED = "[redacted]";

const RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // URL userinfo: keep scheme and host, drop user:password@.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(?::[^\s/@]+)?@/gi,
    replacement: `$1${REDACTED}@`,
  },
  // Authorization header or assignment. Match an optional scheme word
  // (Bearer, Basic, ...) plus the credential token, not the rest of the line,
  // so sibling fields in single-line logs survive. The alphabetic scheme guard
  // also keeps this idempotent: a prior [redacted] cannot be re-consumed.
  {
    pattern: /\b(authorization)\s*[:=]\s*(?:[A-Za-z]+\s+)?\S+/gi,
    replacement: `$1: ${REDACTED}`,
  },
  // Standalone bearer and basic credentials without an Authorization key.
  { pattern: /\bBearer\s+[\w.~+/=-]+/gi, replacement: `Bearer ${REDACTED}` },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=._-]+/gi, replacement: `Basic ${REDACTED}` },
  // GitHub personal, OAuth, user, server, and refresh tokens.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  // GitHub fine-grained personal access tokens.
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  // OpenAI and Anthropic style provider keys (sk-, sk-ant-, sk-proj-, ...).
  {
    pattern: /\bsk-(?:ant-|proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gi,
    replacement: REDACTED,
  },
  // Google API keys.
  { pattern: /\bAIza[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  // Slack tokens.
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gi, replacement: REDACTED },
  // Three-part dotted tokens: Discord bot tokens and JWTs.
  {
    pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },
  // Secret-like assignments: keep the key and separator, redact the value.
  // Covers env-style names (OPENAI_API_KEY, DB_PASSWORD) by matching any
  // identifier containing a secret word, in any casing or separator style.
  // Quoted values allow escaped quotes so a value with spaces and \" inside
  // is consumed whole rather than leaking its tail to the \S+ fallback.
  {
    pattern:
      /\b([\w.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|priv(?:ate)?[_-]?key)[\w.-]*)(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\S+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
];

export function redact(value: string): string {
  return RULES.reduce(
    (text, rule) => text.replace(rule.pattern, rule.replacement),
    value,
  );
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
