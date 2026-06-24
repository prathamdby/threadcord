import { describe, expect, it } from "vitest";
import { redact, summarizeError } from "../src/util/redact.js";

// Synthetic, shape-valid secrets. None are real credentials. Each is assembled
// from a prefix and body at runtime so no source literal is a complete token a
// secret scanner would flag, while the runtime value still exercises the regex.
const join = (...parts: string[]): string => parts.join("");

const GH_TOKEN = join("ghp_", "0123456789abcdefghijABCDEFGHIJ0123");
const GH_OAUTH = join("gho_", "abcdefghijklmnopqrstuvwxyz0123456789");
const GH_PAT = join("github_pat_", "11ABCDE0000aaaaaBBBBBcc1234567890");
const OPENAI_KEY = join("sk-", "test0123456789abcdefXYZ0123");
const ANTHROPIC_KEY = join("sk-ant-", "api03-0123456789abcdefghijKLMNOP");
const GOOGLE_KEY = join("AIza", "SyA0000000000000000000000000abcd");
const SLACK_TOKEN = join("xoxb-", "0000000000-0000000000-abcdefABCDEF");
const PASSWORD_VALUE = join("p@ss", "-w0rd.with/segments");
const DISCORD_TOKEN = [
  "MTAxMjM0NTY3ODkwMTIzNDU2",
  "GhIjKl",
  "0123456789abcdefghijABCDEFGHI",
].join(".");
const JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "0123456789abcdefghijABCDEFGHIJklmnopqrstuvwx",
].join(".");
const BASIC_CREDS = join("dXNlcjpw", "YXNzd29yZA==");

describe("redact: known token families", () => {
  const cases: { name: string; secret: string }[] = [
    { name: "GitHub personal token", secret: GH_TOKEN },
    { name: "GitHub OAuth token", secret: GH_OAUTH },
    { name: "GitHub fine-grained PAT", secret: GH_PAT },
    { name: "OpenAI provider key", secret: OPENAI_KEY },
    { name: "Anthropic provider key", secret: ANTHROPIC_KEY },
    { name: "Google API key", secret: GOOGLE_KEY },
    { name: "Slack token", secret: SLACK_TOKEN },
    { name: "Discord bot token", secret: DISCORD_TOKEN },
    { name: "JWT", secret: JWT },
  ];

  it.each(cases)("redacts a $name in error text", ({ secret }) => {
    const out = redact(`clone failed with ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });
});

describe("redact: authorization headers", () => {
  it("redacts a multi-part bearer authorization value as a whole", () => {
    const out = redact(`Authorization: Bearer ${JWT}`);
    expect(out).toBe("Authorization: [redacted]");
  });

  it("redacts a basic authorization value as a whole", () => {
    const out = redact(`Authorization: Basic ${BASIC_CREDS}`);
    expect(out).toBe("Authorization: [redacted]");
  });

  it("redacts an authorization assignment using equals", () => {
    const out = redact(`authorization=Bearer ${GH_TOKEN}`);
    expect(out).not.toContain(GH_TOKEN);
    expect(out).toContain("[redacted]");
  });

  it("keeps trailing fields in a single-line log", () => {
    const out = redact(`Authorization: Bearer ${JWT} method=GET status=500`);
    expect(out).toBe("Authorization: [redacted] method=GET status=500");
    expect(out).not.toContain(JWT);
  });
});

describe("redact: standalone bearer and basic credentials", () => {
  it("redacts a standalone bearer credential", () => {
    expect(redact(`token is Bearer ${OPENAI_KEY}`)).toBe(
      "token is Bearer [redacted]",
    );
  });

  it("redacts a standalone basic credential", () => {
    expect(redact(`sent Basic ${BASIC_CREDS}`)).toBe("sent Basic [redacted]");
  });
});

describe("redact: secret assignments keep the key, drop the value", () => {
  const cases: { name: string; input: string; expected: string }[] = [
    {
      name: "lowercase token",
      input: "config token=super-secret-value",
      expected: "config token=[redacted]",
    },
    {
      name: "env-style provider key",
      input: `OPENAI_API_KEY=${OPENAI_KEY}`,
      expected: "OPENAI_API_KEY=[redacted]",
    },
    {
      name: "hyphenated key with colon",
      input: "api-key: abc.def-ghi",
      expected: "api-key: [redacted]",
    },
    {
      name: "mixed-case provider key spelling",
      input: `Anthropic_Api_Key = ${ANTHROPIC_KEY}`,
      expected: "Anthropic_Api_Key = [redacted]",
    },
    {
      name: "password with punctuation and segments",
      input: `DB_PASSWORD=${PASSWORD_VALUE}`,
      expected: "DB_PASSWORD=[redacted]",
    },
    {
      name: "access token with dotted segments",
      input: "access_token: aaa.bbb-ccc_ddd",
      expected: "access_token: [redacted]",
    },
    {
      name: "quoted secret value",
      input: 'client_secret="multi word secret value"',
      expected: "client_secret=[redacted]",
    },
    {
      name: "quoted secret value with escaped quote and spaces",
      input: 'client_secret="my escaped \\" secret_here"',
      expected: "client_secret=[redacted]",
    },
  ];

  it.each(cases)("redacts $name", ({ input, expected }) => {
    expect(redact(input)).toBe(expected);
  });
});

describe("redact: URL credentials", () => {
  it("redacts userinfo while keeping scheme and host", () => {
    const out = redact(
      "clone https://alice:s3cr3t-token@github.com/acme/app.git",
    );
    expect(out).toBe("clone https://[redacted]@github.com/acme/app.git");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("s3cr3t-token");
  });
});

describe("redact: non-secret operational text stays readable", () => {
  const readable = [
    "Cloning into '/tmp/work' failed: connection timed out after 30s",
    "fatal: repository not found",
    "refreshed access token successfully",
    "authorization failed for user alice",
    "git push rejected: non-fast-forward",
  ];

  it.each(readable)("leaves %s untouched", (text) => {
    expect(redact(text)).toBe(text);
  });
});

describe("redact: idempotency", () => {
  it("is a fixed point", () => {
    const input = `Authorization: Bearer ${JWT}; OPENAI_API_KEY=${OPENAI_KEY}`;
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });
});

describe("summarizeError", () => {
  it("redacts secrets embedded in Error messages", () => {
    const error = new Error("request failed: api_key=not-for-discord");
    expect(summarizeError(error)).toBe("request failed: api_key=[redacted]");
  });

  it("redacts secrets in non-Error throwables", () => {
    expect(summarizeError(`boom ${GH_TOKEN}`)).toBe("boom [redacted]");
  });
});
