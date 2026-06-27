import type { McpTransport } from "@flue/runtime";
import type { McpServerConfig } from "../flue/mcp.js";

const VALID_TRANSPORTS: readonly string[] = ["streamable-http", "sse"];

export type ValidateAddResult =
  | {
      ok: true;
      config: McpServerConfig;
      token?: string;
      customHeaders?: Record<string, string>;
    }
  | { ok: false; message: string };

export function validateAddInputs(
  id: string,
  url: string,
  tokenRaw: string,
  transportRaw: string,
  headersRaw: string,
): ValidateAddResult {
  if (!/^[a-z0-9-]+$/.test(id)) {
    return {
      ok: false,
      message:
        "Invalid server id. Use lowercase letters, numbers, and hyphens only.",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      message: "Invalid URL. Provide a full URL like `https://mcp.example.com`.",
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      message: "Invalid URL protocol. Use `http:` or `https:` only.",
    };
  }

  let transport: McpTransport | undefined;
  if (transportRaw) {
    if (!VALID_TRANSPORTS.includes(transportRaw)) {
      return {
        ok: false,
        message: `Invalid transport. Must be one of: ${VALID_TRANSPORTS.join(", ")}`,
      };
    }
    transport = transportRaw as McpTransport;
  }

  let customHeaders: Record<string, string> | undefined;
  if (headersRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(headersRaw);
    } catch {
      return { ok: false, message: "Headers must be valid JSON." };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== "string")
    ) {
      return {
        ok: false,
        message: "Headers must be a JSON object of strings.",
      };
    }
    customHeaders = parsed as Record<string, string>;
  }

  const token = tokenRaw || undefined;
  const mergedHeaders = buildHeaders(customHeaders, token);

  const config: McpServerConfig = {
    id,
    url,
    ...(transport ? { transport } : {}),
    ...(mergedHeaders ? { headers: mergedHeaders } : {}),
  };

  return {
    ok: true,
    config,
    ...(token ? { token } : {}),
    ...(customHeaders ? { customHeaders } : {}),
  };
}

export function buildHeaders(
  customHeaders?: Record<string, string>,
  token?: string,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (customHeaders) Object.assign(headers, customHeaders);
  if (token) headers.Authorization = `Bearer ${token}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}
