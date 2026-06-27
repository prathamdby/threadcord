import { describe, expect, it } from "vitest";
import { buildHeaders, validateAddInputs } from "../src/mcp/validation.js";

describe("validateAddInputs", () => {
  it("rejects invalid server ids", () => {
    expect(validateAddInputs("Bad_Id", "https://x.com", "", "", "")).toEqual({
      ok: false,
      message: expect.stringContaining("Invalid server id"),
    });
  });

  it("rejects invalid URLs", () => {
    expect(validateAddInputs("valid-id", "not-a-url", "", "", "")).toEqual({
      ok: false,
      message: expect.stringContaining("Invalid URL"),
    });
  });

  it("rejects non-http URL protocols", () => {
    expect(
      validateAddInputs("valid-id", "file:///etc/passwd", "", "", ""),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("Invalid URL protocol"),
    });
  });

  it("rejects invalid transport values", () => {
    expect(
      validateAddInputs("valid-id", "https://x.com", "", "carrier-pigeon", ""),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("Invalid transport"),
    });
  });

  it("rejects non-object headers JSON", () => {
    expect(
      validateAddInputs("valid-id", "https://x.com", "", "", '["a"]'),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("JSON object of strings"),
    });
  });

  it("rejects invalid JSON in headers", () => {
    expect(
      validateAddInputs("valid-id", "https://x.com", "", "", "{bad}"),
    ).toEqual({
      ok: false,
      message: expect.stringContaining("valid JSON"),
    });
  });

  it("accepts valid inputs with all optional fields", () => {
    const result = validateAddInputs(
      "my-server",
      "https://mcp.example.com",
      "secret-token",
      "sse",
      '{"X-Tenant": "acme"}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.id).toBe("my-server");
      expect(result.config.url).toBe("https://mcp.example.com");
      expect(result.config.transport).toBe("sse");
      expect(result.config.headers).toEqual({
        "X-Tenant": "acme",
        Authorization: "Bearer secret-token",
      });
      expect(result.token).toBe("secret-token");
      expect(result.customHeaders).toEqual({ "X-Tenant": "acme" });
    }
  });

  it("accepts valid inputs with no optional fields", () => {
    const result = validateAddInputs(
      "simple",
      "https://mcp.example.com",
      "",
      "",
      "",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.id).toBe("simple");
      expect(result.config.transport).toBeUndefined();
      expect(result.config.headers).toBeUndefined();
      expect(result.token).toBeUndefined();
      expect(result.customHeaders).toBeUndefined();
    }
  });
});

describe("buildHeaders", () => {
  it("returns undefined when no headers or token", () => {
    expect(buildHeaders(undefined, undefined)).toBeUndefined();
  });

  it("merges custom headers with bearer token", () => {
    expect(buildHeaders({ "X-Foo": "bar" }, "tok")).toEqual({
      "X-Foo": "bar",
      Authorization: "Bearer tok",
    });
  });

  it("returns only bearer token when no custom headers", () => {
    expect(buildHeaders(undefined, "tok")).toEqual({
      Authorization: "Bearer tok",
    });
  });

  it("returns only custom headers when no token", () => {
    expect(buildHeaders({ "X-Foo": "bar" }, undefined)).toEqual({
      "X-Foo": "bar",
    });
  });
});
