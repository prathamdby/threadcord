import { ButtonStyle, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildCustomId } from "../src/discord/ui/index.js";
import { mcpAddModalId, mcpRemoveSelectId } from "../src/mcp/custom-id.js";
import { handleMcpInteraction } from "../src/mcp/interactions.js";
import type { McpStore, McpServerRow } from "../src/mcp/store.js";
import { buildHeaders, validateAddInputs } from "../src/mcp/validation.js";
import type { McpPool } from "../src/flue/mcp.js";

const IS_COMPONENTS_V2 = 32768;
const EPHEMERAL = 64;

function expectComponentsV2(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty("content");
  expect((payload.flags as number) & MessageFlags.IsComponentsV2).toBe(
    IS_COMPONENTS_V2,
  );
}

function expectEphemeralComponentsV2(payload: Record<string, unknown>) {
  expectComponentsV2(payload);
  expect((payload.flags as number) & MessageFlags.Ephemeral).toBe(EPHEMERAL);
}

function serverRow(id: string, url = `https://${id}.example.com`): McpServerRow {
  return {
    id,
    url,
    createdAt: new Date(0),
  };
}

function createMockStore(initial: McpServerRow[] = []): {
  store: McpStore;
  state: McpServerRow[];
} {
  const state = [...initial];
  const store = {
    listServers: vi.fn(async () => [...state].sort((a, b) => a.id.localeCompare(b.id))),
    getServer: vi.fn(async (id: string) => state.find((row) => row.id === id)),
    addServer: vi.fn(async (input: McpServerRow) => {
      const row = { ...input, createdAt: new Date(0) };
      state.push(row);
      return row;
    }),
    removeServer: vi.fn(async (id: string) => {
      const index = state.findIndex((row) => row.id === id);
      if (index < 0) return false;
      state.splice(index, 1);
      return true;
    }),
  } as unknown as McpStore;
  return { store, state };
}

function createMockPool(): McpPool {
  return {
    addServer: vi.fn(async () => ({ tools: [{ name: "alpha" }, { name: "beta" }] })),
    removeServer: vi.fn(async () => true),
  } as unknown as McpPool;
}

function mockChatCommand(input: {
  subcommand: string;
  userId?: string;
}): {
  interaction: ReturnType<typeof buildChatInteraction>["interaction"];
  calls: ReturnType<typeof buildChatInteraction>["calls"];
} {
  return buildChatInteraction({
    userId: input.userId ?? "user-1",
    subcommand: input.subcommand,
  });
}

function buildChatInteraction(input: { userId: string; subcommand: string }) {
  const calls = {
    reply: [] as unknown[],
    editReply: [] as unknown[],
    followUp: [] as unknown[],
    deferReply: [] as unknown[],
    showModal: [] as unknown[],
    update: [] as unknown[],
  };
  const interaction = {
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => false,
    commandName: "mcp",
    user: { id: input.userId },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => input.subcommand,
    },
    showModal: vi.fn(async (modal) => {
      calls.showModal.push(modal.toJSON());
    }),
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      calls.reply.push(payload);
    }),
    editReply: vi.fn(async (payload) => {
      calls.editReply.push(payload);
    }),
    followUp: vi.fn(async (payload) => {
      calls.followUp.push(payload);
    }),
    deferReply: vi.fn(async (opts?: { flags?: number }) => {
      interaction.deferred = true;
      calls.deferReply.push(opts ?? {});
    }),
    update: vi.fn(async (payload) => {
      calls.update.push(payload);
    }),
  };
  return { interaction, calls };
}

function mockSelectInteraction(input: {
  userId: string;
  customId: string;
  values: string[];
}): {
  interaction: Record<string, unknown>;
  calls: { update: unknown[]; reply: unknown[]; followUp: unknown[] };
} {
  const calls = { update: [] as unknown[], reply: [] as unknown[], followUp: [] as unknown[] };
  const interaction = {
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    customId: input.customId,
    values: input.values,
    user: { id: input.userId },
    deferred: false,
    replied: false,
    update: vi.fn(async (payload) => {
      calls.update.push(payload);
    }),
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      calls.reply.push(payload);
    }),
    followUp: vi.fn(async (payload) => {
      calls.followUp.push(payload);
    }),
    editReply: vi.fn(),
    deferReply: vi.fn(),
  };
  return { interaction, calls };
}

function mockButtonInteraction(input: {
  userId: string;
  customId: string;
}): {
  interaction: Record<string, unknown>;
  calls: {
    update: unknown[];
    reply: unknown[];
    followUp: unknown[];
    deferUpdate: unknown[];
    editReply: unknown[];
  };
} {
  const calls = {
    update: [] as unknown[],
    reply: [] as unknown[],
    followUp: [] as unknown[],
    deferUpdate: [] as unknown[],
    editReply: [] as unknown[],
  };
  const interaction = {
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: input.customId,
    user: { id: input.userId },
    deferred: false,
    replied: false,
    update: vi.fn(async (payload) => {
      calls.update.push(payload);
    }),
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      calls.reply.push(payload);
    }),
    followUp: vi.fn(async (payload) => {
      calls.followUp.push(payload);
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
      calls.deferUpdate.push({});
    }),
    editReply: vi.fn(async (payload) => {
      calls.editReply.push(payload);
    }),
    deferReply: vi.fn(),
  };
  return { interaction, calls };
}

function mockModalSubmit(input: {
  userId: string;
  customId: string;
  fields: Record<string, string>;
}): {
  interaction: Record<string, unknown>;
  calls: { reply: unknown[]; editReply: unknown[]; deferReply: unknown[] };
} {
  const calls = { reply: [] as unknown[], editReply: [] as unknown[], deferReply: [] as unknown[] };
  const interaction = {
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    customId: input.customId,
    user: { id: input.userId },
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (key: string) => input.fields[key] ?? "",
    },
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      calls.reply.push(payload);
    }),
    editReply: vi.fn(async (payload) => {
      calls.editReply.push(payload);
    }),
    deferReply: vi.fn(async (opts?: { flags?: number }) => {
      interaction.deferred = true;
      calls.deferReply.push(opts ?? {});
    }),
    followUp: vi.fn(),
    update: vi.fn(),
  };
  return { interaction, calls };
}

function containerText(payload: Record<string, unknown>): string {
  const container = (payload.components as Array<{ components: Array<{ content?: string }> }>)[0]!;
  return container.components
    .filter((part) => part.content)
    .map((part) => part.content)
    .join("\n");
}

function actionButtons(payload: Record<string, unknown>) {
  const container = (payload.components as Array<{ components: Array<Record<string, unknown>> }>)[0]!;
  const row = container.components.find((part) => part.type === 1);
  return (row?.components as Array<Record<string, unknown>>) ?? [];
}

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

  it("rejects server ids longer than 50 characters", () => {
    const id = "a".repeat(51);
    expect(validateAddInputs(id, "https://x.com", "", "", "")).toEqual({
      ok: false,
      message: expect.stringContaining("at most 50 characters"),
    });
  });

  it("accepts server ids up to 50 characters", () => {
    const id = "a".repeat(50);
    expect(validateAddInputs(id, "https://x.com", "", "", "")).toEqual({
      ok: true,
      config: expect.objectContaining({ id }),
    });
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

describe("handleMcpInteraction /mcp add", () => {
  it("opens the add modal with a registry custom id", async () => {
    const { interaction, calls } = mockChatCommand({ subcommand: "add", userId: "user-42" });
    const { store } = createMockStore();
    const pool = createMockPool();

    const handled = await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(handled).toBe(true);
    expect(calls.showModal).toHaveLength(1);
    const modal = calls.showModal[0] as { custom_id: string; title: string };
    expect(modal.custom_id).toBe(mcpAddModalId("user-42"));
    expect(modal.title).toBe("Add MCP Server");
  });

  it("returns validation errorView for invalid modal input", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "user-1",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "Bad_Id",
        url: "https://x.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store } = createMockStore();
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(calls.deferReply).toHaveLength(1);
    expect(calls.editReply).toHaveLength(1);
    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect(containerText(payload)).toContain("Invalid server id");
  });

  it("returns infoView after a successful add", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "user-1",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "new-server",
        url: "https://mcp.example.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store, state } = createMockStore();
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(pool.addServer).toHaveBeenCalledOnce();
    expect(store.addServer).toHaveBeenCalledOnce();
    expect(state.map((row) => row.id)).toEqual(["new-server"]);
    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect(containerText(payload)).toContain("MCP Server added");
    expect(containerText(payload)).toContain("2 tools available");
  });

  it("rejects modal submit from another user", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "other-user",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "new-server",
        url: "https://mcp.example.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store } = createMockStore();
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    const payload = calls.reply[0] as Record<string, unknown>;
    expectEphemeralComponentsV2(payload);
    expect(containerText(payload)).toContain("Action not allowed");
  });

  it("returns validation error when server id already exists", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "user-1",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "existing",
        url: "https://mcp.example.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store } = createMockStore([serverRow("existing")]);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(pool.addServer).not.toHaveBeenCalled();
    const payload = calls.editReply[0] as Record<string, unknown>;
    expect(containerText(payload)).toContain("already exists");
  });

  it("returns error when pool.addServer rejects", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "user-1",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "new-server",
        url: "https://mcp.example.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store } = createMockStore();
    const pool = createMockPool();
    vi.mocked(pool.addServer).mockRejectedValueOnce(new Error("connection refused"));

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(store.addServer).not.toHaveBeenCalled();
    const payload = calls.editReply[0] as Record<string, unknown>;
    expect(containerText(payload)).toContain("Failed to connect");
  });

  it("rolls back pool and reports save failure when store.addServer rejects", async () => {
    const { interaction, calls } = mockModalSubmit({
      userId: "user-1",
      customId: mcpAddModalId("user-1"),
      fields: {
        id: "new-server",
        url: "https://mcp.example.com",
        token: "",
        transport: "",
        headers: "",
      },
    });
    const { store } = createMockStore();
    const pool = createMockPool();
    vi.mocked(store.addServer).mockRejectedValueOnce(new Error("db write failed"));

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(pool.addServer).toHaveBeenCalledOnce();
    expect(pool.removeServer).toHaveBeenCalledWith("new-server");
    const payload = calls.editReply[0] as Record<string, unknown>;
    expect(containerText(payload)).toContain("Connected but failed to save");
  });
});

describe("handleMcpInteraction /mcp list", () => {
  it("shows empty infoView when no servers exist", async () => {
    const { interaction, calls } = mockChatCommand({ subcommand: "list" });
    const { store } = createMockStore();
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(calls.deferReply).toHaveLength(1);
    expect(calls.deferReply[0]).toEqual({ flags: MessageFlags.Ephemeral });
    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect(payload).not.toHaveProperty("content");
    expect(containerText(payload)).toContain("No MCP servers configured.");
  });

  it("lists one server without pagination controls", async () => {
    const { interaction, calls } = mockChatCommand({ subcommand: "list" });
    const { store } = createMockStore([serverRow("alpha")]);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect(containerText(payload)).toContain("alpha");
    expect(actionButtons(payload)).toHaveLength(0);
  });

  it("paginates 26 servers across two pages", async () => {
    const servers = Array.from({ length: 26 }, (_, index) =>
      serverRow(`server-${String(index).padStart(2, "0")}`),
    );
    const { interaction, calls } = mockChatCommand({ subcommand: "list", userId: "user-9" });
    const { store } = createMockStore(servers);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    const firstPage = calls.editReply[0] as Record<string, unknown>;
    const buttons = actionButtons(firstPage);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({ label: "Previous", disabled: true });
    expect(buttons[1]).toMatchObject({
      label: "Next",
      disabled: false,
      custom_id: buildCustomId("mcp", "list", "page", "user-9", "1"),
    });

    const pageButton = mockButtonInteraction({
      userId: "user-9",
      customId: buildCustomId("mcp", "list", "page", "user-9", "1"),
    });
    await handleMcpInteraction({
      interaction: pageButton.interaction as never,
      store,
      pool,
    });

    const secondPage = pageButton.calls.update[0] as Record<string, unknown>;
    expectEphemeralComponentsV2(secondPage);
    const secondButtons = actionButtons(secondPage);
    expect(secondButtons[0]).toMatchObject({ label: "Previous", disabled: false });
    expect(secondButtons[1]).toMatchObject({ label: "Next", disabled: true });
    expect(containerText(secondPage)).toContain("server-25");
  });
});

describe("handleMcpInteraction /mcp remove", () => {
  it("shows validation error when no servers exist", async () => {
    const { interaction, calls } = mockChatCommand({ subcommand: "remove" });
    const { store } = createMockStore();
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(calls.deferReply).toHaveLength(1);
    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect(containerText(payload)).toContain("No MCP servers configured.");
  });

  it("defers before listing servers on /mcp remove", async () => {
    const callOrder: string[] = [];
    const { store } = createMockStore([serverRow("alpha")]);
    store.listServers = vi.fn(async () => {
      callOrder.push("listServers");
      return [serverRow("alpha")];
    });
    const { interaction, calls } = mockChatCommand({ subcommand: "remove" });
    interaction.deferReply = vi.fn(async () => {
      callOrder.push("deferReply");
      interaction.deferred = true;
      calls.deferReply.push({});
    });

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool: createMockPool(),
    });

    expect(callOrder.indexOf("deferReply")).toBeLessThan(
      callOrder.indexOf("listServers"),
    );
  });

  it("replies with a select menu populated from the store", async () => {
    const { interaction, calls } = mockChatCommand({ subcommand: "remove", userId: "user-7" });
    const { store } = createMockStore([
      serverRow("alpha"),
      serverRow("beta"),
    ]);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: interaction as never,
      store,
      pool,
    });

    expect(calls.deferReply).toHaveLength(1);
    const payload = calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    const container = (payload.components as Array<{ components: Array<Record<string, unknown>> }>)[0]!;
    const selectRow = container.components.find((part) => part.type === 1);
    const menu = (selectRow?.components as Array<Record<string, unknown>>)[0]!;
    expect(menu).toMatchObject({
      type: 3,
      custom_id: mcpRemoveSelectId("user-7"),
    });
    const options = menu.options as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual(["alpha", "beta"]);
  });

  it("shows confirmView after selecting a server", async () => {
    const select = mockSelectInteraction({
      userId: "user-7",
      customId: mcpRemoveSelectId("user-7"),
      values: ["alpha"],
    });
    const { store } = createMockStore([serverRow("alpha")]);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: select.interaction as never,
      store,
      pool,
    });

    const payload = select.calls.update[0] as Record<string, unknown>;
    expectEphemeralComponentsV2(payload);
    expect(containerText(payload)).toContain("Remove server `alpha`");
    const buttons = actionButtons(payload);
    expect(buttons[0]).toMatchObject({
      label: "Confirm",
      style: ButtonStyle.Danger,
      custom_id: buildCustomId("mcp", "remove", "confirm", "user-7", "alpha"),
    });
    expect(buttons[1]).toMatchObject({
      label: "Cancel",
      style: ButtonStyle.Secondary,
      custom_id: buildCustomId("mcp", "remove", "cancel", "user-7", "alpha"),
    });
  });

  it("does not remove from the store when cancel is clicked", async () => {
    const { store, state } = createMockStore([serverRow("alpha")]);
    const pool = createMockPool();
    const cancel = mockButtonInteraction({
      userId: "user-7",
      customId: buildCustomId("mcp", "remove", "cancel", "user-7", "alpha"),
    });

    await handleMcpInteraction({
      interaction: cancel.interaction as never,
      store,
      pool,
    });

    expect(store.removeServer).not.toHaveBeenCalled();
    expect(pool.removeServer).not.toHaveBeenCalled();
    expect(state).toHaveLength(1);
    const payload = cancel.calls.update[0] as Record<string, unknown>;
    expect(containerText(payload)).toContain("Removal cancelled.");
    expect(actionButtons(payload)).toHaveLength(0);
  });

  it("removes from store and pool only after confirm", async () => {
    const { store, state } = createMockStore([serverRow("alpha")]);
    const pool = createMockPool();
    const confirm = mockButtonInteraction({
      userId: "user-7",
      customId: buildCustomId("mcp", "remove", "confirm", "user-7", "alpha"),
    });

    await handleMcpInteraction({
      interaction: confirm.interaction as never,
      store,
      pool,
    });

    expect(confirm.calls.deferUpdate).toHaveLength(1);
    expect(pool.removeServer).toHaveBeenCalledWith("alpha");
    expect(store.removeServer).toHaveBeenCalledWith("alpha");
    expect(state).toHaveLength(0);
    const payload = confirm.calls.editReply[0] as Record<string, unknown>;
    expectComponentsV2(payload);
    expect((payload.flags as number) & MessageFlags.Ephemeral).toBe(0);
    expect(containerText(payload)).toContain("MCP server `alpha` was removed.");
    expect(actionButtons(payload)).toHaveLength(0);
  });

  it("defers update before store/pool IO on remove confirm", async () => {
    const callOrder: string[] = [];
    const { store } = createMockStore([serverRow("alpha")]);
    store.getServer = vi.fn(async () => {
      callOrder.push("getServer");
      return serverRow("alpha");
    });
    store.removeServer = vi.fn(async () => {
      callOrder.push("removeServer");
      return true;
    });
    const pool = createMockPool();
    pool.removeServer = vi.fn(async () => {
      callOrder.push("pool.removeServer");
      return true;
    });
    const confirm = mockButtonInteraction({
      userId: "user-7",
      customId: buildCustomId("mcp", "remove", "confirm", "user-7", "alpha"),
    });
    confirm.interaction.deferUpdate = vi.fn(async () => {
      callOrder.push("deferUpdate");
      confirm.interaction.deferred = true;
      confirm.calls.deferUpdate.push({});
    });

    await handleMcpInteraction({
      interaction: confirm.interaction as never,
      store,
      pool,
    });

    expect(callOrder.indexOf("deferUpdate")).toBeLessThan(
      callOrder.indexOf("getServer"),
    );
    expect(callOrder.indexOf("deferUpdate")).toBeLessThan(
      callOrder.indexOf("pool.removeServer"),
    );
  });

  it("rejects remove interactions from another user", async () => {
    const select = mockSelectInteraction({
      userId: "intruder",
      customId: mcpRemoveSelectId("user-7"),
      values: ["alpha"],
    });
    const { store } = createMockStore([serverRow("alpha")]);
    const pool = createMockPool();

    await handleMcpInteraction({
      interaction: select.interaction as never,
      store,
      pool,
    });

    const payload = select.calls.reply[0] as Record<string, unknown>;
    expect(containerText(payload)).toContain("Action not allowed");
  });
});

describe("handleMcpInteraction fallthrough", () => {
  it("replies with validation error for unknown mcp custom ids", async () => {
    const button = mockButtonInteraction({
      userId: "user-1",
      customId: buildCustomId("mcp", "unknown", "action"),
    });
    const { store } = createMockStore();
    const pool = createMockPool();

    const handled = await handleMcpInteraction({
      interaction: button.interaction as never,
      store,
      pool,
    });

    expect(handled).toBe(true);
    expect(button.calls.reply).toHaveLength(1);
    expectEphemeralComponentsV2(button.calls.reply[0] as Record<string, unknown>);
    expect(containerText(button.calls.reply[0] as Record<string, unknown>)).toContain(
      "Unknown MCP action",
    );
  });
});
