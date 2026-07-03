import { MessageFlags, type Interaction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildCustomId } from "../src/discord/ui/index.js";
import { routeInteraction, toThreadMessage } from "../src/discord/gateway.js";
import type { McpStore } from "../src/mcp/store.js";
import type { SetupOrchestrator } from "../src/setup/orchestrator.js";
import type { SetupStore } from "../src/setup/store.js";
import type { TaskOrchestrator } from "../src/task/orchestrator.js";

const IS_COMPONENTS_V2 = 32768;

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
