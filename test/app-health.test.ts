import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountHealthRoutes } from "../src/app.js";
import type { TaskStore } from "../src/task/store.js";
import type { SidecarProbeResult } from "../src/agentturn/index.js";

function fakeStore(healthy: boolean): TaskStore {
  return {
    health: vi.fn(async () => healthy),
    migrate: vi.fn(async () => {}),
    listExpiredWorkspacePaths: vi.fn(async () => []),
  } as unknown as TaskStore;
}

function fakeDiscord(ready: boolean): { isReady(): boolean } {
  return { isReady: () => ready };
}

function fakeProbe(
  result: Partial<SidecarProbeResult> = {},
): () => Promise<SidecarProbeResult> {
  return async () =>
    ({
      ok: true,
      path: "/opt/agentos/sidecar",
      executable: true,
      arch: "arm64",
      version: "v1",
      ...result,
    }) as SidecarProbeResult;
}

describe("health endpoints", () => {
  it("GET /health/live returns 200 when Postgres is up and 503 when down", async () => {
    const appUp = new Hono();
    mountHealthRoutes(appUp, {
      store: fakeStore(true),
      discordClient: fakeDiscord(false),
      probeSidecar: fakeProbe(),
    });
    const resUp = await appUp.request("/health/live");
    expect(resUp.status).toBe(200);
    await expect(resUp.json()).resolves.toMatchObject({
      ok: true,
      postgres: true,
      agentos: { ok: true },
    });

    const appDown = new Hono();
    mountHealthRoutes(appDown, {
      store: fakeStore(false),
      discordClient: fakeDiscord(false),
      probeSidecar: fakeProbe(),
    });
    const resDown = await appDown.request("/health/live");
    expect(resDown.status).toBe(503);
    await expect(resDown.json()).resolves.toMatchObject({
      ok: false,
      postgres: false,
      agentos: { ok: true },
    });
  });

  it("GET /health returns 200 only when Postgres and Discord are ready, 503 otherwise", async () => {
    const cases = [
      { postgres: true, discord: true, expected: 200 },
      { postgres: true, discord: false, expected: 503 },
      { postgres: false, discord: true, expected: 503 },
      { postgres: false, discord: false, expected: 503 },
    ];

    for (const { postgres, discord, expected } of cases) {
      const app = new Hono();
      mountHealthRoutes(app, {
        store: fakeStore(postgres),
        discordClient: fakeDiscord(discord),
        probeSidecar: fakeProbe(),
      });
      const res = await app.request("/health");
      expect(res.status).toBe(expected);
      const body = await res.json();
      expect(body.postgres).toBe(postgres);
      expect(body.discord).toBe(discord);
      expect(body.ok).toBe(postgres && discord);
      expect(body.agentos.ok).toBe(true);
    }
  });

  it("GET /health reports AgentOS not ready with a missing or bad sidecar", async () => {
    const app = new Hono();
    mountHealthRoutes(app, {
      store: fakeStore(true),
      discordClient: fakeDiscord(true),
      probeSidecar: fakeProbe({
        ok: false,
        executable: false,
        error: "sidecar binary not found",
      }),
    });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.agentos.ok).toBe(false);
    expect(body.agentos.error).toMatch(/sidecar binary not found/i);
  });

  it("GET /health returns 200 when Postgres, Discord, and sidecar are all ready", async () => {
    const app = new Hono();
    mountHealthRoutes(app, {
      store: fakeStore(true),
      discordClient: fakeDiscord(true),
      probeSidecar: fakeProbe(),
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.postgres).toBe(true);
    expect(body.discord).toBe(true);
    expect(body.agentos.ok).toBe(true);
  });

  it("GET /health/live reflects AgentOS readiness as well as Postgres", async () => {
    const app = new Hono();
    mountHealthRoutes(app, {
      store: fakeStore(true),
      discordClient: fakeDiscord(false),
      probeSidecar: fakeProbe({
        ok: false,
        executable: false,
        error: "sidecar architecture mismatch",
      }),
    });
    const res = await app.request("/health/live");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.postgres).toBe(true);
    expect(body.agentos.ok).toBe(false);
    expect(body.agentos.error).toMatch(/architecture mismatch/i);
  });
});
