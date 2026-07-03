import {
  ButtonStyle,
  ModalBuilder,
  type ActionRowBuilder,
  type ButtonBuilder,
} from "discord.js";
import {
  buildCustomId,
  button,
  buttonRow,
  confirmView,
  modalRow,
  parseCustomId,
  viewWithRows,
  type ViewPayload,
} from "../discord/ui/index.js";
import type { SetupDraft } from "./profile.js";
import { renderEnvironment } from "./renderer.js";

export function parseDraftCustomId(
  raw: string,
): { action: string; draftId: string; confirmStep?: string } | null {
  const parsed = parseCustomId(raw);
  if (!parsed || parsed.ns !== "setup") return null;
  const { action, params } = parsed;
  if (action === "discard" && params.length === 2) {
    const [confirmStep, draftId] = params;
    if (!confirmStep || !draftId) return null;
    if (confirmStep !== "confirm" && confirmStep !== "cancel") return null;
    return { action, draftId, confirmStep };
  }
  const [draftId] = params;
  if (!draftId || params.length !== 1) return null;
  return { action, draftId };
}

export function draftCustomId(action: string, draftId: string): string {
  return buildCustomId("setup", action, draftId);
}

export function draftBodyText(draft: SetupDraft): { title: string; body: string } {
  return {
    title: `Setup draft ${draft.id}`,
    body: [
      `Base revision: ${draft.baseRevision}`,
      `Validation: ${draft.validationStatus}`,
      draft.validationMessage ? `Message: ${draft.validationMessage}` : undefined,
      "",
      renderEnvironment(draft.environment),
      "",
      "Memory preview:",
      preview(draft.memoryMarkdown, 1400),
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
}

export function renderDraftView(draft: SetupDraft): ViewPayload {
  const { title, body } = draftBodyText(draft);
  return viewWithRows(title, body, draftButtonRows(draft));
}

export function renderDiscardConfirmView(draft: SetupDraft): ViewPayload {
  return confirmView(
    "Discard this setup draft? Unsaved changes will be lost.",
    buildCustomId("setup", "discard", "confirm", draft.id),
    buildCustomId("setup", "discard", "cancel", draft.id),
  );
}

function draftButtonRows(
  draft: SetupDraft,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    buttonRow([
      button(
        draftCustomId("commands", draft.id),
        "Commands",
        ButtonStyle.Secondary,
      ),
      button(
        draftCustomId("requirements", draft.id),
        "Env and services",
        ButtonStyle.Secondary,
      ),
      button(
        draftCustomId("memory", draft.id),
        "Memory",
        ButtonStyle.Secondary,
      ),
    ]),
    buttonRow([
      button(
        draftCustomId("validate", draft.id),
        "Validate",
        ButtonStyle.Primary,
      ),
      button(
        draftCustomId("apply", draft.id),
        "Apply",
        ButtonStyle.Success,
      ),
      button(
        draftCustomId("discard", draft.id),
        "Discard",
        ButtonStyle.Danger,
      ),
    ]),
  ];
}

export function commandsModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(draftCustomId("commands", draft.id))
    .setTitle("Setup commands")
    .addLabelComponents(
      modalRow("install", "Install command", {
        value: draft.environment.install,
        required: true,
      }),
      modalRow("start", "Start command", {
        value: draft.environment.start,
      }),
      modalRow("checks", "Checks as name=command lines", {
        value: checksText(draft),
      }),
      modalRow("skills", "Skills (URLs, one per line)", {
        value: (draft.environment.skills ?? []).join("\n"),
      }),
    );
}

export function requirementsModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(draftCustomId("requirements", draft.id))
    .setTitle("Setup requirements")
    .addLabelComponents(
      modalRow("requiredEnv", "Required env names", {
        value: draft.environment.requiredEnv.join("\n"),
      }),
      modalRow("requiredServices", "Required services", {
        value: draft.environment.requiredServices.join("\n"),
      }),
    );
}

export function memoryModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(draftCustomId("memory", draft.id))
    .setTitle("Setup memory")
    .addLabelComponents(
      modalRow("memoryMarkdown", "Memory Markdown", {
        value: draft.memoryMarkdown.slice(0, 4000),
        required: true,
        style: "paragraph",
        maxLength: 4000,
      }),
    );
}

function checksText(draft: SetupDraft): string {
  return Object.entries(draft.environment.checks)
    .map(([name, command]) => `${name}=${command}`)
    .join("\n");
}

export function checksTooLargeForModal(draft: SetupDraft): boolean {
  return checksText(draft).length > 4000;
}

export function memoryTooLargeForModal(draft: SetupDraft): boolean {
  return draft.memoryMarkdown.length > 4000;
}

function preview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 15).trimEnd()}\n...truncated`;
}
