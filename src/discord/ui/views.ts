import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  type APIMessageTopLevelComponent,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export const VIEW_TEXT_LIMIT = 4000;
export const VIEW_COMPONENT_LIMIT = 40;
export const LIST_VIEW_DEFAULT_PAGE_SIZE = 25;

export type ErrorKind = "validation" | "rejection" | "internal";

export interface ViewPayload {
  components: APIMessageTopLevelComponent[];
  flags: number;
}

const TRUNCATION_MARKER = "\n…[truncated]";

/**
 * Local 4000-char clamp for Components-v2 text (message `content` has a 2000
 * cap handled by discord/limits.ts; text displays allow 4000 total).
 */
export function clampViewText(text: string, maxLength = VIEW_TEXT_LIMIT): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= TRUNCATION_MARKER.length) return text.slice(0, maxLength);
  return text.slice(0, maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function payload(container: ContainerBuilder): ViewPayload {
  return {
    components: [container.toJSON()],
    flags: MessageFlags.IsComponentsV2,
  };
}

function titledContainer(title: string, body: string): ContainerBuilder {
  const heading = `## ${clampViewText(title, 200)}`;
  const bodyBudget = VIEW_TEXT_LIMIT - heading.length;
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(heading),
  );
  if (body) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(clampViewText(body, bodyBudget)),
    );
  }
  return container;
}

export function infoView(title: string, body: string): ViewPayload {
  return payload(titledContainer(title, body));
}

const ERROR_TITLES: Record<ErrorKind, string> = {
  validation: "Invalid input",
  rejection: "Action not allowed",
  internal: "Something went wrong",
};

export const INTERNAL_ERROR_BODY =
  "An internal error occurred. Please try again later.";

export function errorView(kind: ErrorKind, detail?: string): ViewPayload {
  const body =
    kind === "internal"
      ? INTERNAL_ERROR_BODY
      : detail || "The request could not be completed.";
  return payload(titledContainer(ERROR_TITLES[kind], body));
}

export function confirmView(
  prompt: string,
  confirmCustomId: string,
  cancelCustomId: string,
): ViewPayload {
  return payload(
    confirmContainer(prompt, confirmCustomId, cancelCustomId),
  );
}

function confirmContainer(
  prompt: string,
  confirmCustomId: string,
  cancelCustomId: string,
): ContainerBuilder {
  const confirmButton = new ButtonBuilder()
    .setCustomId(confirmCustomId)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Danger);
  const cancelButton = new ButtonBuilder()
    .setCustomId(cancelCustomId)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(clampViewText(prompt)),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmButton,
        cancelButton,
      ),
    );
}

export function viewWithRows(
  title: string,
  body: string,
  rows: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): ViewPayload {
  const container = titledContainer(title, body);
  for (const row of rows) {
    container.addActionRowComponents(row);
  }
  return payload(container);
}

export function listView(
  title: string,
  items: string[],
  page: number,
  pageSize = LIST_VIEW_DEFAULT_PAGE_SIZE,
  pageCustomIdBuilder?: (page: number) => string,
): ViewPayload {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageItems = items.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const body =
    pageItems.length === 0 ? "(no items)" : pageItems.join("\n");
  const container = titledContainer(title, body);
  if (pageCount > 1 && pageCustomIdBuilder) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(pageCustomIdBuilder(currentPage - 1))
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(pageCustomIdBuilder(currentPage + 1))
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= pageCount - 1),
      ),
    );
  }
  return payload(container);
}

export function kvView(title: string, entries: [string, string][]): ViewPayload {
  const body =
    entries.length === 0
      ? "(empty)"
      : entries.map(([key, value]) => `**${key}**: ${value}`).join("\n");
  return payload(titledContainer(title, body));
}
