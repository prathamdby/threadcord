import { Events, MessageFlags, type Interaction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildCustomId } from "../src/discord/ui/index.js";
import type { McpStore } from "../src/mcp/store.js";
import type { SetupOrchestrator } from "../src/setup/orchestrator.js";
import type { SetupStore } from "../src/setup/store.js";
import type { TaskOrchestrator } from "../src/task/orchestrator.js";

const IS_COMPONENTS_V2 = 32768;

type ClientStub = {
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  handlers: Map<string | symbol, (...args: unknown[]) => void>;
};

const clientStubs: ClientStub[] = [];

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    Client: vi.fn(function MockClient(this: ClientStub) {
      const handlers = new Map<
        string | symbol,
        (...args: unknown[]) => void
      >();
      this.handlers = handlers;
      this.once = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      });
      this.on = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      });
      this.login = vi.fn().mockResolvedValue(undefined);
      clientStubs.push(this);
    }),
  };
});

vi.mock("../src/mcp/interactions.js", () => ({
  handleMcpInteraction: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/task/interactions.js", () => ({
  handleTaskInteraction: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/setup/interactions.js", () => ({
  handleSetupInteraction: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/flue/mcp.js", () => ({
  getMcpPool: vi.fn().mockReturnValue({}),
}));

import {
  routeInteraction,
  startDiscordGateway,
  toThreadMessage,
} from "../src/discord/gateway.js";
import { handleMcpInteraction } from "../src/mcp/interactions.js";
import { handleSetupInteraction } from "../src/setup/interactions.js";
import { handleTaskInteraction } from "../src/task/interactions.js";

const config = {} as AppConfig;
const taskOrchestrator = {} as TaskOrchestrator;
const setupStore = {} as SetupStore;
const setupOrchestrator = {} as SetupOrchestrator;
const mcpStore = {} as McpStore;

function routeArgs() {
  return [
    config,
    taskOrchestrator,
    setupStore,
    setupOrchestrator,
    mcpStore,
  ] as const;
}

function mockRepliableInteraction(
  overrides: Record<string, unknown> = {},
) {
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    customId: "",
    commandName: "",
    deferred: false,
    replied: false,
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    ...overrides,
  };
  return interaction;
}

describe("routeInteraction namespace dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientStubs.length = 0;
    vi.mocked(handleMcpInteraction).mockResolvedValue(true);
    vi.mocked(handleTaskInteraction).mockResolvedValue(true);
    vi.mocked(handleSetupInteraction).mockResolvedValue(true);
  });

  it("routes slash commands by commandName", async () => {
    await routeInteraction(
      mockRepliableInteraction({
        isChatInputCommand: () => true,
        commandName: "task",
      }) as unknown as Interaction,
      ...routeArgs(),
    );
    expect(handleTaskInteraction).toHaveBeenCalledTimes(1);
    expect(handleMcpInteraction).not.toHaveBeenCalled();
    expect(handleSetupInteraction).not.toHaveBeenCalled();
  });

  it("routes component interactions by customId namespace", async () => {
    const customId = buildCustomId("setup", "draft", "open", "user-1");
    await routeInteraction(
      mockRepliableInteraction({
        isButton: () => true,
        customId,
      }) as unknown as Interaction,
      ...routeArgs(),
    );
    expect(handleSetupInteraction).toHaveBeenCalledTimes(1);
    expect(handleTaskInteraction).not.toHaveBeenCalled();
    expect(handleMcpInteraction).not.toHaveBeenCalled();
  });

  it("routes mcp modal submits by namespace", async () => {
    const customId = buildCustomId("mcp", "add", "user-1");
    await routeInteraction(
      mockRepliableInteraction({
        isModalSubmit: () => true,
        customId,
      }) as unknown as Interaction,
      ...routeArgs(),
    );
    expect(handleMcpInteraction).toHaveBeenCalledTimes(1);
  });

  it("replies with internal error for unknown customId namespace", async () => {
    const interaction = mockRepliableInteraction({
      isButton: () => true,
      customId: "unknown:action:1",
    });
    await routeInteraction(interaction as unknown as Interaction, ...routeArgs());
    expect(handleTaskInteraction).not.toHaveBeenCalled();
    expect(handleSetupInteraction).not.toHaveBeenCalled();
    expect(handleMcpInteraction).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: IS_COMPONENTS_V2 | MessageFlags.Ephemeral,
      }),
    );
  });

  it("replies with internal error for unknown slash commands", async () => {
    const interaction = mockRepliableInteraction({
      isChatInputCommand: () => true,
      commandName: "ping",
    });
    await routeInteraction(interaction as unknown as Interaction, ...routeArgs());
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: IS_COMPONENTS_V2 | MessageFlags.Ephemeral,
      }),
    );
  });

  it("replies with internal error when a handler throws", async () => {
    vi.mocked(handleTaskInteraction).mockRejectedValueOnce(new Error("boom"));
    const interaction = mockRepliableInteraction({
      isChatInputCommand: () => true,
      commandName: "task",
    });
    await routeInteraction(interaction as unknown as Interaction, ...routeArgs());
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: IS_COMPONENTS_V2 | MessageFlags.Ephemeral,
      }),
    );
  });
});

describe("startDiscordGateway message routing boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientStubs.length = 0;
  });

  function startGateway(orchestrator: TaskOrchestrator) {
    startDiscordGateway(
      "token",
      config,
      orchestrator,
      setupStore,
      setupOrchestrator,
      mcpStore,
    );
    const stub = clientStubs[0];
    if (!stub) throw new Error("expected Client stub");
    return stub;
  }

  async function expectMessageRejectionContained(
    messageHandler: (...args: unknown[]) => void,
    message: unknown,
    expectedSummary: string,
  ) {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      messageHandler(message);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        "[threadcord] message routing failed:",
        expectedSummary,
      );
    } finally {
      process.off("unhandledRejection", handler);
      errorSpy.mockRestore();
    }
  }

  it("does not produce an unhandledRejection when routeMessage rejects", async () => {
    const orchestrator = {
      handleChannelMessage: vi
        .fn()
        .mockRejectedValue(new Error("routing boom")),
      handleThreadMessage: vi.fn(),
    } as unknown as TaskOrchestrator;

    const stub = startGateway(orchestrator);
    const messageHandler = stub.handlers.get(Events.MessageCreate);
    expect(messageHandler).toBeTypeOf("function");
    if (!messageHandler) throw new Error("expected MessageCreate handler");

    await expectMessageRejectionContained(
      messageHandler,
      {
        partial: false,
        author: { bot: false },
        channel: { isThread: () => false },
        channelId: "channel-1",
        id: "m-1",
        content: "hello",
        attachments: { size: 0, values: () => [] },
      },
      "routing boom",
    );
  });

  it("contains handleThreadMessage rejections without unhandledRejection", async () => {
    const orchestrator = {
      handleChannelMessage: vi.fn(),
      handleThreadMessage: vi
        .fn()
        .mockRejectedValue(new Error("thread routing boom")),
    } as unknown as TaskOrchestrator;

    const stub = startGateway(orchestrator);
    const messageHandler = stub.handlers.get(Events.MessageCreate);
    if (!messageHandler) throw new Error("expected MessageCreate handler");

    await expectMessageRejectionContained(
      messageHandler,
      {
        partial: false,
        author: { id: "user-1", bot: false },
        channel: { isThread: () => true },
        channelId: "thread-1",
        guildId: "guild-1",
        id: "m-1",
        content: "hello",
        attachments: { size: 0, values: () => [] },
        client: { user: { id: "bot-1" } },
        reply: vi.fn(),
        react: vi.fn(),
        reactions: { resolve: () => null },
      },
      "thread routing boom",
    );
  });

  it("contains message.fetch rejections for partial messages", async () => {
    const orchestrator = {
      handleChannelMessage: vi.fn(),
      handleThreadMessage: vi.fn(),
    } as unknown as TaskOrchestrator;

    const stub = startGateway(orchestrator);
    const messageHandler = stub.handlers.get(Events.MessageCreate);
    if (!messageHandler) throw new Error("expected MessageCreate handler");

    await expectMessageRejectionContained(
      messageHandler,
      {
        partial: true,
        fetch: vi.fn().mockRejectedValue(new Error("fetch failed")),
      },
      "fetch failed",
    );
  });

  it("logs a redacted summary when routeMessage rejects with a secret", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890AB";
    const orchestrator = {
      handleChannelMessage: vi
        .fn()
        .mockRejectedValue(new Error(`Auth failed: ${token}`)),
      handleThreadMessage: vi.fn(),
    } as unknown as TaskOrchestrator;

    const stub = startGateway(orchestrator);
    const messageHandler = stub.handlers.get(Events.MessageCreate);
    if (!messageHandler) throw new Error("expected MessageCreate handler");

    await expectMessageRejectionContained(
      messageHandler,
      {
        partial: false,
        author: { bot: false },
        channel: { isThread: () => false },
        channelId: "channel-1",
        id: "m-1",
        content: "hello",
        attachments: { size: 0, values: () => [] },
      },
      "Auth failed: [redacted]",
    );
  });

  it("wires InteractionCreate through startDiscordGateway", async () => {
    startGateway({} as TaskOrchestrator);
    const stub = clientStubs[0];
    if (!stub) throw new Error("expected Client stub");
    const interactionHandler = stub.handlers.get(Events.InteractionCreate);
    expect(interactionHandler).toBeTypeOf("function");
    if (!interactionHandler) throw new Error("expected InteractionCreate handler");

    await interactionHandler(
      mockRepliableInteraction({
        isChatInputCommand: () => true,
        commandName: "task",
      }),
    );

    expect(handleTaskInteraction).toHaveBeenCalledTimes(1);
  });
});

describe("toThreadMessage", () => {
  it("carries authorId and replyView for in-thread CV2 replies", async () => {
    const viewReplies: unknown[] = [];
    const message = {
      id: "m-1",
      content: "abort",
      author: { id: "user-42", bot: false },
      authorBot: false,
      channelId: "thread-1",
      guildId: "guild-1",
      client: { user: { id: "bot-1" } },
      reply: vi.fn().mockImplementation(async (payload: unknown) => {
        viewReplies.push(payload);
      }),
      react: vi.fn().mockResolvedValue(undefined),
      reactions: {
        resolve: () => ({ users: { remove: vi.fn().mockResolvedValue(undefined) } }),
      },
    };

    const threadMessage = toThreadMessage(message as never);
    expect(threadMessage.authorId).toBe("user-42");

    const payload = { components: [], flags: IS_COMPONENTS_V2 };
    await threadMessage.replyView!(payload);
    expect(viewReplies).toEqual([payload]);
  });
});
