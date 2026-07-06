import { MessageFlags, type Interaction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { handleSetupInteraction } from "../src/setup/interactions.js";
import type { SetupDraft, SetupProfile, SetupRun } from "../src/setup/profile.js";
import { profileSelectCustomId } from "../src/setup/profile-select.js";
import type { SetupOrchestrator } from "../src/setup/orchestrator.js";
import type { SetupStore } from "../src/setup/store.js";

const IS_COMPONENTS_V2 = 32768;

const baseProfile: SetupProfile = {
  id: "profile-1",
  repo: "owner/repo",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: {
    install: "npm ci",
    start: "npm run dev",
    checks: { test: "npm test" },
    requiredEnv: ["DATABASE_URL"],
    requiredServices: ["postgres"],
  },
  memoryMarkdown: "Use npm.",
  lastRunId: "run-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const baseDraft: SetupDraft = {
  id: "draft-1",
  profileId: "profile-1",
  discordUserId: "user-1",
  baseRevision: 2,
  environment: baseProfile.environment,
  memoryMarkdown: "Use npm.",
  validationStatus: "unchecked",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function expectComponentsV2Reply(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty("content");
  expect(payload.flags as number & MessageFlags).toBe(
    IS_COMPONENTS_V2 | MessageFlags.Ephemeral,
  );
}

function expectComponentsV2EditReply(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty("content");
  expect((payload.flags as number) & IS_COMPONENTS_V2).toBe(IS_COMPONENTS_V2);
}

function mockStore(
  overrides: Partial<SetupStore> = {},
): SetupStore {
  return {
    listProfiles: vi.fn().mockResolvedValue([baseProfile]),
    getProfileById: vi.fn().mockResolvedValue(baseProfile),
    getProfile: vi.fn().mockResolvedValue(baseProfile),
    getRun: vi.fn().mockResolvedValue(undefined),
    createDraft: vi.fn().mockResolvedValue(baseDraft),
    getDraft: vi.fn().mockResolvedValue(baseDraft),
    updateDraft: vi.fn().mockImplementation(async (input) => ({
      ...baseDraft,
      validationStatus: input.validationStatus ?? baseDraft.validationStatus,
      validationMessage: input.validationMessage,
    })),
    applyDraft: vi.fn().mockResolvedValue({ ok: true, profile: baseProfile }),
    discardDraft: vi.fn().mockResolvedValue(true),
    patchEnvironmentWhileRunning: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SetupStore;
}

function mockOrchestrator(): SetupOrchestrator {
  return {} as SetupOrchestrator;
}

const ALLOWED_MODELS = ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"];
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const config = {
  allowedModels: ALLOWED_MODELS,
  defaultModel: DEFAULT_MODEL,
} as unknown as AppConfig;

function mockChatCommand(input: {
  subcommand: string;
  userId?: string;
  options?: Record<string, unknown>;
}) {
  const options = {
    getSubcommand: () => input.subcommand,
    getString: (name: string, required?: boolean) => {
      const value = input.options?.[name];
      if (value === undefined && required) throw new Error(`Missing ${name}`);
      return value as string | null;
    },
    getAttachment: (name: string) => input.options?.[name] ?? null,
  };
  const interaction = {
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    commandName: "setup",
    user: { id: input.userId ?? "user-1" },
    options,
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
  };
  return interaction;
}

function mockButton(input: {
  customId: string;
  userId?: string;
  deferred?: boolean;
  replied?: boolean;
}) {
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    customId: input.customId,
    user: { id: input.userId ?? "user-1" },
    deferred: input.deferred ?? false,
    replied: input.replied ?? false,
    showModal: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    update: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
  };
  return interaction;
}

function mockSelect(input: {
  customId: string;
  values: string[];
  userId?: string;
  deferred?: boolean;
}) {
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    customId: input.customId,
    values: input.values,
    user: { id: input.userId ?? "user-1" },
    deferred: input.deferred ?? false,
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
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
  };
  return interaction;
}

function mockModal(input: {
  customId: string;
  userId?: string;
  fields?: Record<string, string>;
  selects?: Record<string, string[]>;
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
      getTextInputValue: (name: string) => input.fields?.[name] ?? "",
      getStringSelectValues: (name: string) => input.selects?.[name] ?? [],
    },
    showModal: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    fetchReply: vi.fn().mockResolvedValue({ id: "msg-1" }),
  };
  return interaction;
}

function oversizedChecksDraft(): SetupDraft {
  const checks: Record<string, string> = {};
  let line = "x=y";
  while (line.length <= 4000) {
    checks[`check-${Object.keys(checks).length}`] = "npm test";
    line = Object.entries(checks)
      .map(([name, command]) => `${name}=${command}`)
      .join("\n");
  }
  return {
    ...baseDraft,
    environment: {
      ...baseDraft.environment,
      checks,
    },
  };
}

describe("handleSetupInteraction profile picker", () => {
  it("replies ephemerally with profile select for status when profiles exist", async () => {
    const callOrder: string[] = [];
    const store = mockStore({
      listProfiles: vi.fn().mockImplementation(async () => {
        callOrder.push("listProfiles");
        return [baseProfile];
      }),
    });
    const interaction = mockChatCommand({ subcommand: "status" });
    vi.mocked(interaction.deferReply).mockImplementation(async () => {
      callOrder.push("deferReply");
      interaction.deferred = true;
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(callOrder).toEqual(["deferReply", "listProfiles"]);
    expect(store.listProfiles).toHaveBeenCalledWith(25);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2EditReply(payload);
    expect(JSON.stringify(payload)).toContain(
      profileSelectCustomId("status", "user-1"),
    );
    expect(JSON.stringify(payload)).toContain('"value":"profile-1"');
  });

  it("shows validation error when no profiles exist", async () => {
    const store = mockStore({
      listProfiles: vi.fn().mockResolvedValue([]),
    });
    const interaction = mockChatCommand({ subcommand: "view" });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(interaction.deferReply).toHaveBeenCalled();
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2EditReply(payload);
    expect(JSON.stringify(payload)).toContain("Invalid input");
    expect(JSON.stringify(payload)).toContain("No setup profiles");
  });

  it("notes when profile list hits the cap", async () => {
    const profiles = Array.from({ length: 25 }, (_, index) => ({
      ...baseProfile,
      id: `profile-${index}`,
    }));
    const store = mockStore({
      listProfiles: vi.fn().mockResolvedValue(profiles),
    });
    const interaction = mockChatCommand({ subcommand: "status" });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain("Showing first 25 profiles.");
  });

  it("runs status action after profile selection", async () => {
    const callOrder: string[] = [];
    const run: SetupRun = {
      id: "run-1",
      profileId: "profile-1",
      repo: "owner/repo",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "/workspaces/setup",
      status: "succeeded",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const store = mockStore({
      getProfileById: vi.fn().mockImplementation(async () => {
        callOrder.push("getProfileById");
        return baseProfile;
      }),
      getRun: vi.fn().mockImplementation(async () => {
        callOrder.push("getRun");
        return run;
      }),
    });
    const interaction = mockSelect({
      customId: profileSelectCustomId("status", "user-1"),
      values: ["profile-1"],
    });
    vi.mocked(interaction.deferUpdate).mockImplementation(async () => {
      callOrder.push("deferUpdate");
      interaction.deferred = true;
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(callOrder.slice(0, 2)).toEqual(["deferUpdate", "getProfileById"]);
    expect(store.getProfileById).toHaveBeenCalledWith("profile-1");
    expect(interaction.deferUpdate).toHaveBeenCalled();
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2EditReply(payload);
    expect(JSON.stringify(payload)).toContain("owner/repo @ main");
  });
});

describe("handleSetupInteraction draft editor", () => {
  it("validate updates draft and re-renders cv2 draft view", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:validate:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(store.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft-1", validationStatus: "valid" }),
    );
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.flags as number).toBe(IS_COMPONENTS_V2);
    expect(payload).not.toHaveProperty("content");
    expect(JSON.stringify(payload)).toContain("Validate");
  });

  it("apply saves draft and shows profile view", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:apply:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(store.applyDraft).toHaveBeenCalledWith("draft-1");
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.flags as number).toBe(IS_COMPONENTS_V2);
    expect(JSON.stringify(payload)).toContain("Install");
  });

  it("discard shows confirm view before deleting", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:discard:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(store.discardDraft).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
    const payload = vi.mocked(interaction.update).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain("setup:discard:confirm:draft-1");
    expect(JSON.stringify(payload)).toContain("setup:discard:cancel:draft-1");
  });

  it("discard confirm deletes draft", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:discard:confirm:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(store.discardDraft).toHaveBeenCalledWith("draft-1");
  });

  it("discard confirm by non-owner is rejected and does not discard", async () => {
    const store = mockStore({
      getDraft: vi.fn().mockResolvedValue({
        ...baseDraft,
        discordUserId: "other-user",
      }),
    });
    const interaction = mockButton({
      customId: "setup:discard:confirm:draft-1",
      userId: "user-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(store.discardDraft).not.toHaveBeenCalled();
    const payload = vi.mocked(interaction.reply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2Reply(payload);
    expect(JSON.stringify(payload)).toContain("Action not allowed");
  });

  it("discard cancel restores draft view", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:discard:cancel:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(store.discardDraft).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
    const payload = vi.mocked(interaction.update).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain("setup:validate:draft-1");
    expect(JSON.stringify(payload)).toContain("setup:discard:draft-1");
  });

  it("rejects draft actions from non-owner", async () => {
    const store = mockStore({
      getDraft: vi.fn().mockResolvedValue({
        ...baseDraft,
        discordUserId: "other-user",
      }),
    });
    const interaction = mockButton({
      customId: "setup:validate:draft-1",
      userId: "user-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    const payload = vi.mocked(interaction.reply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2Reply(payload);
    expect(JSON.stringify(payload)).toContain("Action not allowed");
  });

  it("replies with validation error for unknown setup buttons", async () => {
    const store = mockStore();
    const interaction = mockButton({
      customId: "setup:unknown:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    const payload = vi.mocked(interaction.reply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2Reply(payload);
    expect(JSON.stringify(payload)).toContain("Unknown setup action");
  });

  it("blocks commands modal when checks are too large", async () => {
    const store = mockStore({
      getDraft: vi.fn().mockResolvedValue(oversizedChecksDraft()),
    });
    const interaction = mockButton({
      customId: "setup:commands:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(interaction.showModal).not.toHaveBeenCalled();
    const payload = vi.mocked(interaction.reply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain("too many check commands");
  });

  it("blocks memory modal when memory is too large", async () => {
    const store = mockStore({
      getDraft: vi.fn().mockResolvedValue({
        ...baseDraft,
        memoryMarkdown: "x".repeat(4001),
      }),
    });
    const interaction = mockButton({
      customId: "setup:memory:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    expect(interaction.showModal).not.toHaveBeenCalled();
    const payload = vi.mocked(interaction.reply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain("too large for a Discord modal");
  });

  it("apply conflict shows revision mismatch message", async () => {
    const store = mockStore({
      applyDraft: vi.fn().mockResolvedValue({ ok: false, reason: "conflict" }),
    });
    const interaction = mockButton({
      customId: "setup:apply:draft-1",
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator: mockOrchestrator(),
    });
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload)).toContain(
      "Profile changed since this draft was opened",
    );
  });
});

describe("handleSetupInteraction create/update commands", () => {
  it.each(["create", "update"] as const)(
    "shows wizard modal for /setup %s without ephemeral reply",
    async (subcommand) => {
      const store = mockStore();
      const interaction = mockChatCommand({ subcommand, userId: "user-42" });
      await handleSetupInteraction({
        interaction: interaction as unknown as Interaction,
        store,
        config,
        orchestrator: mockOrchestrator(),
      });
      expect(interaction.showModal).toHaveBeenCalledTimes(1);
      const modal = vi.mocked(interaction.showModal).mock.calls[0]?.[0] as {
        data: { custom_id: string };
      };
      expect(modal.data.custom_id).toBe(
        `setup:create-run:${subcommand}:user-42`,
      );
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.deferReply).not.toHaveBeenCalled();
    },
  );
});

describe("handleSetupInteraction wizard modal", () => {
  it("create wizard patches skills only before dispatch", async () => {
    const patchEnvironmentWhileRunning = vi.fn().mockResolvedValue(undefined);
    const store = mockStore({
      patchEnvironmentWhileRunning,
    });
    const orchestrator = {
      startSetup: vi.fn().mockResolvedValue({
        profileId: "profile-1",
        runId: "run-2",
        repo: "owner/repo",
        branch: "main",
      }),
      registerSetupThread: vi.fn(),
      dispatchSetupAgent: vi.fn(),
    } as unknown as SetupOrchestrator;
    const interaction = mockModal({
      customId: "setup:create-run:create:user-1",
      fields: {
        repo: "owner/repo",
        branch: "main",
        skills: "https://example.com/skill.md",
      },
      selects: { model: ["anthropic/claude-sonnet-4-5"] },
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator,
    });
    expect(store.getProfile).not.toHaveBeenCalled();
    expect(orchestrator.startSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-5",
        update: false,
      }),
    );
    expect(patchEnvironmentWhileRunning).toHaveBeenCalledWith("profile-1", {
      skills: ["https://example.com/skill.md"],
    });
    expect(orchestrator.dispatchSetupAgent).toHaveBeenCalled();
  });

  it("update wizard patches install, checks, and skills before dispatch", async () => {
    const patchEnvironmentWhileRunning = vi.fn().mockResolvedValue(undefined);
    const store = mockStore({
      getProfile: vi.fn().mockResolvedValue(baseProfile),
      patchEnvironmentWhileRunning,
    });
    const orchestrator = {
      startSetup: vi.fn().mockResolvedValue({
        profileId: "profile-1",
        runId: "run-2",
        repo: "owner/repo",
        branch: "main",
      }),
      registerSetupThread: vi.fn(),
      dispatchSetupAgent: vi.fn(),
    } as unknown as SetupOrchestrator;
    const interaction = mockModal({
      customId: "setup:create-run:update:user-1",
      fields: {
        repo: "owner/repo",
        branch: "main",
        skills: "",
        install: "npm ci",
        checks: "test=npm test",
      },
      selects: { model: ["openai/gpt-4o"] },
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator,
    });
    expect(store.getProfile).toHaveBeenCalledWith("owner/repo", "main");
    expect(orchestrator.startSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o",
        update: true,
      }),
    );
    expect(patchEnvironmentWhileRunning).toHaveBeenCalledWith("profile-1", {
      install: "npm ci",
      checks: { test: "npm test" },
      skills: [],
    });
  });

  it("defers before loading profile for update wizard", async () => {
    const callOrder: string[] = [];
    const store = mockStore({
      getProfile: vi.fn().mockImplementation(async () => {
        callOrder.push("getProfile");
        return baseProfile;
      }),
    });
    const orchestrator = {
      startSetup: vi.fn().mockResolvedValue({
        profileId: "profile-1",
        runId: "run-2",
        repo: "owner/repo",
        branch: "main",
      }),
      registerSetupThread: vi.fn(),
      dispatchSetupAgent: vi.fn(),
    } as unknown as SetupOrchestrator;
    const interaction = mockModal({
      customId: "setup:create-run:update:user-1",
      fields: {
        repo: "owner/repo",
        branch: "main",
        skills: "",
        install: "npm ci",
        checks: "test=npm test",
      },
      selects: { model: ["anthropic/claude-sonnet-4-5"] },
    });
    vi.mocked(interaction.deferReply).mockImplementation(async () => {
      callOrder.push("deferReply");
      interaction.deferred = true;
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator,
    });
    expect(callOrder.slice(0, 2)).toEqual(["deferReply", "getProfile"]);
  });

  it("update wizard rejects missing profile after defer", async () => {
    const patchEnvironmentWhileRunning = vi.fn().mockResolvedValue(undefined);
    const store = mockStore({
      getProfile: vi.fn().mockResolvedValue(undefined),
      patchEnvironmentWhileRunning,
    });
    const startSetup = vi.fn();
    const orchestrator = {
      startSetup,
      registerSetupThread: vi.fn(),
      dispatchSetupAgent: vi.fn(),
    } as unknown as SetupOrchestrator;
    const interaction = mockModal({
      customId: "setup:create-run:update:user-1",
      fields: {
        repo: "owner/repo",
        branch: "main",
        skills: "",
        install: "npm ci",
        checks: "test=npm test",
      },
      selects: { model: ["anthropic/claude-sonnet-4-5"] },
    });
    await handleSetupInteraction({
      interaction: interaction as unknown as Interaction,
      store,
      config,
      orchestrator,
    });
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(store.getProfile).toHaveBeenCalledWith("owner/repo", "main");
    expect(startSetup).not.toHaveBeenCalled();
    expect(patchEnvironmentWhileRunning).not.toHaveBeenCalled();
    const payload = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expectComponentsV2EditReply(payload);
    expect(JSON.stringify(payload)).toContain("Setup profile is missing");
    expect(JSON.stringify(payload)).toContain("before updating");
  });
});
