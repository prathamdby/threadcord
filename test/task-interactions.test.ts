import { MessageFlags, type Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildCustomId } from "../src/discord/ui/index.js";
import type { SetupProfile } from "../src/setup/profile.js";
import type { SetupStore } from "../src/setup/store.js";
import { handleTaskInteraction } from "../src/task/interactions.js";
import {
  parseTaskCreateModalCustomId,
  taskCreateModalCustomId,
} from "../src/task/profile-select.js";
import type { TaskOrchestrator } from "../src/task/orchestrator.js";

const IS_COMPONENTS_V2 = 32768;

const baseProfile: SetupProfile = {
  id: "profile-1",
  repo: "owner/repo",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: {
    install: "npm ci",
    start: "",
    checks: {},
    requiredEnv: [],
    requiredServices: [],
  },
  memoryMarkdown: "memory",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const config = {
  allowedModels: ["anthropic/claude-sonnet-4-5"],
  defaultModel: "anthropic/claude-sonnet-4-5",
} as AppConfig;

function expectEphemeralComponentsV2(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty("content");
  expect(payload.flags as number).toBe(IS_COMPONENTS_V2 | MessageFlags.Ephemeral);
}

function mockSetupStore(
  overrides: Partial<SetupStore> = {},
): SetupStore {
  return {
    listReadyProfiles: vi.fn().mockResolvedValue([baseProfile]),
    getProfileById: vi.fn().mockResolvedValue(baseProfile),
    ...overrides,
  } as unknown as SetupStore;
}

function mockOrchestrator(): TaskOrchestrator {
  return {
    startTaskFromSlash: vi.fn().mockResolvedValue({
      ok: true,
      threadId: "thread-1",
      startedImmediately: true,
    }),
  } as unknown as TaskOrchestrator;
}

function mockChatCommand(input: {
  subcommand: string;
  userId?: string;
}) {
  const interaction = {
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    commandName: "task",
    user: { id: input.userId ?? "user-1" },
    options: { getSubcommand: () => input.subcommand },
    deferred: false,
    replied: false,
    showModal: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    fetchReply: vi.fn().mockResolvedValue({
      startThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
    }),
  };
  return interaction;
}

function mockModal(input: {
  customId: string;
  userId?: string;
  profileId?: string;
  model?: string;
  instruction?: string;
}) {
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    customId: input.customId,
    user: { id: input.userId ?? "user-1" },
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (id: string) => {
        if (id === "model") return input.model ?? "anthropic/claude-sonnet-4-5";
        if (id === "instruction") return input.instruction ?? "fix tests";
        throw new Error(`unknown field ${id}`);
      },
      getStringSelectValues: (id: string) => {
        if (id === "profile") return [input.profileId ?? "profile-1"];
        if (id === "model") return [input.model ?? "anthropic/claude-sonnet-4-5"];
        throw new Error(`unknown select ${id}`);
      },
    },
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
  };
  return interaction;
}

describe("task create modal custom ids", () => {
  it("builds and parses via the task namespace registry", () => {
    expect(taskCreateModalCustomId("user-1")).toBe(
      buildCustomId("task", "create", "modal", "user-1"),
    );
    expect(parseTaskCreateModalCustomId("task:create:modal:user-1")).toEqual({
      userId: "user-1",
    });
  });
});

describe("handleTaskInteraction /task create", () => {
  it("replies with validation error when no ready profiles exist", async () => {
    const store = mockSetupStore({
      listReadyProfiles: vi.fn().mockResolvedValue([]),
    });
    const interaction = mockChatCommand({ subcommand: "create" });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator: mockOrchestrator(),
      setupStore: store,
      config,
    });
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expectEphemeralComponentsV2(
      (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    );
  });

  it("opens a single create modal instead of a profile select menu", async () => {
    const interaction = mockChatCommand({ subcommand: "create" });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator: mockOrchestrator(),
      setupStore: mockSetupStore(),
      config,
    });
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(modal.data.custom_id).toBe(taskCreateModalCustomId("user-1"));
    expect(
      modal.toJSON().components.some((row: { type: number }) => row.type === 18),
    ).toBe(true);
  });

  it("validates missing instruction on modal submit", async () => {
    const interaction = mockModal({
      customId: taskCreateModalCustomId("user-1"),
      instruction: "   ",
    });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator: mockOrchestrator(),
      setupStore: mockSetupStore(),
      config,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expectEphemeralComponentsV2(
      (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    );
  });

  it("rejects modal submit from another user", async () => {
    const interaction = mockModal({
      customId: taskCreateModalCustomId("owner"),
      userId: "intruder",
    });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator: mockOrchestrator(),
      setupStore: mockSetupStore(),
      config,
    });
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expectEphemeralComponentsV2(
      (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    );
  });

  it("uses a public deferred reply and CV2 success payload on create", async () => {
    const orchestrator = mockOrchestrator();
    const interaction = mockModal({
      customId: taskCreateModalCustomId("user-1"),
    });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator,
      setupStore: mockSetupStore(),
      config,
    });
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(
      (interaction.deferReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
        ?.flags,
    ).toBeUndefined();
    expect(orchestrator.startTaskFromSlash).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = (interaction.editReply as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(payload).not.toHaveProperty("content");
    expect(payload.flags & MessageFlags.IsComponentsV2).toBe(IS_COMPONENTS_V2);
    expect(payload.flags & MessageFlags.Ephemeral).toBe(0);
  });
});

describe("handleTaskInteraction control buttons", () => {
  function mockControlButton(input: {
    customId: string;
    userId?: string;
  }) {
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      customId: input.customId,
      user: { id: input.userId ?? "user-1" },
      deferred: false,
      replied: false,
      deferUpdate: vi.fn().mockImplementation(async () => {
        interaction.deferred = true;
      }),
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockImplementation(async () => {
        interaction.replied = true;
      }),
      followUp: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
    };
    return interaction;
  }

  it("defers and edits the confirm message after slow control work", async () => {
    const callOrder: string[] = [];
    const orchestrator = {
      handleControlButton: vi.fn(async (input) => {
        await input.defer();
        callOrder.push("defer");
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push("work");
        await input.update({
          flags: IS_COMPONENTS_V2,
          components: [],
        });
      }),
    } as unknown as TaskOrchestrator;
    const interaction = mockControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        "abort",
        "user-1",
        "task-1",
      ),
    });
    await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator,
      setupStore: mockSetupStore(),
      config,
    });
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["defer", "work"]);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });
});

describe("handleTaskInteraction fallthrough", () => {
  it("replies with validation error for unknown task custom ids", async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      customId: buildCustomId("task", "unknown", "action"),
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      reply: vi.fn().mockImplementation(async () => {
        interaction.replied = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
    };
    const handled = await handleTaskInteraction({
      interaction: interaction as unknown as Interaction,
      orchestrator: mockOrchestrator(),
      setupStore: mockSetupStore(),
      config,
    });
    expect(handled).toBe(true);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expectEphemeralComponentsV2(
      (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    );
  });
});
