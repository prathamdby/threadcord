import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

const MODAL_LABEL_LIMIT = 45;
const SELECT_TEXT_LIMIT = 100;
const SELECT_OPTION_LIMIT = 25;

export interface ModalRowOptions {
  style?: "short" | "paragraph";
  required?: boolean;
  placeholder?: string;
  value?: string;
  maxLength?: number;
}

export function modalRow(
  customId: string,
  label: string,
  opts: ModalRowOptions = {},
): ActionRowBuilder<TextInputBuilder> {
  const maxLength = opts.maxLength ?? 4000;
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label.slice(0, MODAL_LABEL_LIMIT))
    .setMaxLength(maxLength)
    .setRequired(opts.required ?? false)
    .setStyle(
      opts.style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph,
    );
  if (opts.value !== undefined) input.setValue(opts.value.slice(0, maxLength));
  if (opts.placeholder) input.setPlaceholder(opts.placeholder.slice(0, 100));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export interface SelectMenuOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export function selectMenuRow(
  customId: string,
  placeholder: string,
  options: SelectMenuOption[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(truncate(placeholder, SELECT_TEXT_LIMIT))
    .addOptions(
      options.slice(0, SELECT_OPTION_LIMIT).map((option) => ({
        label: truncate(option.label, SELECT_TEXT_LIMIT),
        value: option.value,
        ...(option.description
          ? { description: truncate(option.description, SELECT_TEXT_LIMIT) }
          : {}),
        ...(option.default !== undefined ? { default: option.default } : {}),
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);
}

export function buttonRow(
  buttons: ButtonBuilder[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

export function disableAllComponents(
  rows: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return rows.map((row) => {
    const next = ActionRowBuilder.from<MessageActionRowComponentBuilder>(
      row.toJSON(),
    );
    for (const component of next.components) {
      component.setDisabled(true);
    }
    return next;
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
