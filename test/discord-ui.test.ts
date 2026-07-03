import { describe, expect, it, vi } from "vitest";
import {
  ButtonStyle,
  MessageFlags,
  TextInputStyle,
  type RepliableInteraction,
} from "discord.js";
import {
  CUSTOM_ID_MAX_LENGTH,
  INTERNAL_ERROR_BODY,
  buildCustomId,
  button,
  clampViewText,
  confirmView,
  confirmViewDisabled,
  disableAllComponents,
  errorView,
  ensureDeferred,
  infoView,
  kvView,
  listView,
  modalRow,
  parseCustomId,
  replyWithError,
  respond,
  selectMenuRow,
  viewWithRows,
} from "../src/discord/ui/index.js";

const IS_COMPONENTS_V2 = 32768;

function expectComponentsV2View(payload: { components: unknown[]; flags: number }) {
  expect(payload).not.toHaveProperty("content");
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(IS_COMPONENTS_V2);
}

describe("buildCustomId / parseCustomId", () => {
  it("roundtrips namespace, action, and params", () => {
    const raw = "task:sel:profile:user-42";
    expect(buildCustomId("task", "sel", "profile", "user-42")).toBe(raw);
    expect(parseCustomId(raw)).toEqual({
      ns: "task",
      action: "sel",
      params: ["profile", "user-42"],
    });
  });

  it("returns null for malformed or unknown ids", () => {
    expect(parseCustomId("")).toBeNull();
    expect(parseCustomId("task")).toBeNull();
    expect(parseCustomId("task:")).toBeNull();
    expect(parseCustomId("unknown:action:x")).toBeNull();
    expect(parseCustomId("x".repeat(CUSTOM_ID_MAX_LENGTH + 1))).toBeNull();
  });

  it("throws when build exceeds the 100-char cap", () => {
    const longParam = "y".repeat(95);
    expect(() => buildCustomId("task", "overflow", longParam)).toThrow(
      /exceeds 100 chars/,
    );
  });
});

describe("clampViewText", () => {
  it("appends a truncation marker at the 4000-char limit", () => {
    const input = "a".repeat(4010);
    const clamped = clampViewText(input);
    expect(clamped.length).toBe(4000);
    expect(clamped.endsWith("\n…[truncated]")).toBe(true);
  });
});

describe("infoView", () => {
  it("serializes a titled container without message content", () => {
    const view = infoView("Status", "All good");
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "## Status" },
            { type: 14 },
            { type: 10, content: "All good" },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });

  it("omits the body section when body is empty", () => {
    expect(infoView("Title only", "")).toEqual({
      components: [
        {
          type: 17,
          components: [{ type: 10, content: "## Title only" }],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });
});

describe("errorView", () => {
  it("shows validation detail", () => {
    const view = errorView("validation", "Repo is required");
    expectComponentsV2View(view);
    expect(view.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Invalid input" },
        { type: 14 },
        { type: 10, content: "Repo is required" },
      ],
    });
  });

  it("shows rejection detail", () => {
    const view = errorView("rejection", "Not your draft");
    expect(view.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Action not allowed" },
        { type: 14 },
        { type: 10, content: "Not your draft" },
      ],
    });
  });

  it("hides detail for internal errors", () => {
    const view = errorView("internal", "database connection lost");
    expectComponentsV2View(view);
    expect(view.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Something went wrong" },
        { type: 14 },
        { type: 10, content: INTERNAL_ERROR_BODY },
      ],
    });
    expect(
      JSON.stringify(view).includes("database connection lost"),
    ).toBe(false);
  });
});

describe("confirmView", () => {
  it("renders danger confirm and secondary cancel buttons", () => {
    const view = confirmView("Delete server?", "setup:del:yes", "setup:del:no");
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "Delete server?" },
            {
              type: 1,
              components: [
                {
                  type: 2,
                  custom_id: "setup:del:yes",
                  label: "Confirm",
                  style: ButtonStyle.Danger,
                },
                {
                  type: 2,
                  custom_id: "setup:del:no",
                  label: "Cancel",
                  style: ButtonStyle.Secondary,
                },
              ],
            },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });
});

describe("confirmViewDisabled", () => {
  it("renders confirm and cancel buttons with disabled true", () => {
    const view = confirmViewDisabled(
      "Removed MCP server `foo`.",
      "mcp:rm:yes",
      "mcp:rm:no",
    );
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "Removed MCP server `foo`." },
            {
              type: 1,
              components: [
                {
                  type: 2,
                  custom_id: "mcp:rm:yes",
                  label: "Confirm",
                  style: ButtonStyle.Danger,
                  disabled: true,
                },
                {
                  type: 2,
                  custom_id: "mcp:rm:no",
                  label: "Cancel",
                  style: ButtonStyle.Secondary,
                  disabled: true,
                },
              ],
            },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });
});

describe("viewWithRows", () => {
  it("appends action rows to a titled container without message content", () => {
    const row = selectMenuRow("setup:sel:status:user-1", "Choose profile", [
      { label: "Repo A", value: "a" },
    ]);
    const view = viewWithRows("Setup status", "Pick a profile.", [row]);
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "## Setup status" },
            { type: 14 },
            { type: 10, content: "Pick a profile." },
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: "setup:sel:status:user-1",
                  placeholder: "Choose profile",
                  options: [{ label: "Repo A", value: "a" }],
                },
              ],
            },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });
});

describe("listView", () => {
  it("shows an empty-state body with no pagination for zero items", () => {
    const view = listView("MCP Servers", [], 0);
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "## MCP Servers" },
            { type: 14 },
            { type: 10, content: "(no items)" },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });

  it("fits a single page without prev/next buttons", () => {
    const view = listView("Profiles", ["alpha", "beta"], 0, 25, (page) =>
      buildCustomId("setup", "page", String(page)),
    );
    expectComponentsV2View(view);
    expect(view.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Profiles" },
        { type: 14 },
        { type: 10, content: "alpha\nbeta" },
      ],
    });
  });

  it("paginates across multiple pages with disabled boundary buttons", () => {
    const pageBuilder = (page: number) => `mcp:list:${page}`;
    const firstPage = listView("Items", ["a", "b", "c"], 0, 2, pageBuilder);
    expectComponentsV2View(firstPage);
    expect(firstPage.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Items" },
        { type: 14 },
        { type: 10, content: "a\nb" },
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: "mcp:list:-1",
              label: "Previous",
              style: ButtonStyle.Secondary,
              disabled: true,
            },
            {
              type: 2,
              custom_id: "mcp:list:1",
              label: "Next",
              style: ButtonStyle.Secondary,
              disabled: false,
            },
          ],
        },
      ],
    });

    const lastPage = listView("Items", ["a", "b", "c"], 1, 2, pageBuilder);
    expect(lastPage.components[0]).toEqual({
      type: 17,
      components: [
        { type: 10, content: "## Items" },
        { type: 14 },
        { type: 10, content: "c" },
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: "mcp:list:0",
              label: "Previous",
              style: ButtonStyle.Secondary,
              disabled: false,
            },
            {
              type: 2,
              custom_id: "mcp:list:2",
              label: "Next",
              style: ButtonStyle.Secondary,
              disabled: true,
            },
          ],
        },
      ],
    });
  });
});

describe("kvView", () => {
  it("renders key/value pairs in markdown", () => {
    const view = kvView("Profile", [
      ["Repo", "acme/widget"],
      ["Branch", "main"],
    ]);
    expectComponentsV2View(view);
    expect(view).toEqual({
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "## Profile" },
            { type: 14 },
            {
              type: 10,
              content: "**Repo**: acme/widget\n**Branch**: main",
            },
          ],
        },
      ],
      flags: IS_COMPONENTS_V2,
    });
  });
});

describe("modalRow", () => {
  it("builds a short required input with optional fields", () => {
    const row = modalRow("model", "Model", {
      style: "short",
      required: true,
      value: "anthropic/claude",
      maxLength: 100,
      placeholder: "provider/model",
    });
    expect(row.toJSON()).toEqual({
      type: 18,
      label: "Model",
      component: {
        type: 4,
        custom_id: "model",
        max_length: 100,
        required: true,
        style: TextInputStyle.Short,
        value: "anthropic/claude",
        placeholder: "provider/model",
      },
    });
  });

  it("defaults to a paragraph optional input", () => {
    const row = modalRow("instruction", "Task instruction");
    expect(row.toJSON().component).toMatchObject({
      style: TextInputStyle.Paragraph,
      required: false,
      max_length: 4000,
    });
  });
});

describe("selectMenuRow / button", () => {
  it("builds a select menu row with truncated labels", () => {
    const row = selectMenuRow("task:sel:profile", "Choose profile", [
      { label: "Repo A", value: "a", description: "Ready" },
    ]);
    expect(row.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "task:sel:profile",
          placeholder: "Choose profile",
          options: [{ label: "Repo A", value: "a", description: "Ready" }],
        },
      ],
    });
  });

  it("builds a labeled button", () => {
    expect(button("setup:apply:draft-1", "Apply", ButtonStyle.Success).toJSON()).toEqual({
      type: 2,
      custom_id: "setup:apply:draft-1",
      label: "Apply",
      style: ButtonStyle.Success,
    });
  });
});

describe("disableAllComponents", () => {
  it("disables every component in each action row", () => {
    const row = selectMenuRow("task:sel", "Pick", [{ label: "A", value: "a" }]);
    const disabledRows = disableAllComponents([row]);
    expect(disabledRows[0]!.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "task:sel",
          placeholder: "Pick",
          disabled: true,
          options: [{ label: "A", value: "a" }],
        },
      ],
    });
  });
});

describe("ensureDeferred / respond / replyWithError", () => {
  function mockInteraction(state: {
    deferred?: boolean;
    replied?: boolean;
  }): RepliableInteraction {
    const interaction = {
      deferred: state.deferred ?? false,
      replied: state.replied ?? false,
      deferReply: vi.fn().mockImplementation(async () => {
        interaction.deferred = true;
      }),
      reply: vi.fn().mockImplementation(async () => {
        interaction.replied = true;
      }),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };
    return interaction as unknown as RepliableInteraction;
  }

  it("defers once with ephemeral by default", async () => {
    const interaction = mockInteraction({});
    await ensureDeferred(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    await ensureDeferred(interaction);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  });

  it("replies, edits, or followUps based on interaction state", async () => {
    const payload = infoView("Hello", "World");
    const fresh = mockInteraction({});
    await respond(fresh, payload);
    expect(fresh.reply).toHaveBeenCalledWith({
      ...payload,
      flags: payload.flags | MessageFlags.Ephemeral,
    });

    const deferred = mockInteraction({ deferred: true });
    await respond(deferred, payload);
    expect(deferred.editReply).toHaveBeenCalledWith(payload);

    const replied = mockInteraction({ replied: true });
    await respond(replied, payload);
    expect(replied.followUp).toHaveBeenCalledWith({
      ...payload,
      flags: payload.flags | MessageFlags.Ephemeral,
    });
  });

  it("replyWithError uses errorView and falls back to followUp", async () => {
    const interaction = mockInteraction({ deferred: true });
    (interaction.editReply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("edit failed"),
    );
    await replyWithError(interaction, "validation", "Bad repo");
    expect(interaction.followUp).toHaveBeenCalledWith({
      ...errorView("validation", "Bad repo"),
      flags: errorView("validation", "Bad repo").flags | MessageFlags.Ephemeral,
    });
  });

  it("respond falls back to followUp when editReply rejects on deferred interaction", async () => {
    const interaction = mockInteraction({ deferred: true });
    (interaction.editReply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("edit failed"),
    );
    const payload = infoView("Hello", "World");
    await respond(interaction, payload);
    expect(interaction.followUp).toHaveBeenCalledWith({
      ...payload,
      flags: payload.flags | MessageFlags.Ephemeral,
    });
  });
});
