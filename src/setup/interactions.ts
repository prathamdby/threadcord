import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { summarizeError } from "../util/redact.js";
import {
  type SetupDraft,
  type SetupEnvironment,
  parseSetupProfileKey,
  validateSetupEnvironment,
  validateSetupProfilePayload,
} from "./profile.js";
import { exportProfile, renderDraft, renderSetupProfile } from "./renderer.js";
import type { SetupOrchestrator } from "./orchestrator.js";
import type { SetupStore } from "./store.js";

const SETUP_CUSTOM_ID_PREFIX = "setup:";

export async function registerSetupCommands(client: Client): Promise<void> {
  const command = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Manage durable Threadcord setup profiles.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Run setup for a repository and branch.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("model").setDescription("Optional setup model"),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("update")
        .setDescription("Run setup again and replace the profile on success.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("model").setDescription("Optional setup model"),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show setup status.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View the active setup profile.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Open a draft editor for the active setup profile.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export setup environment JSON and memory Markdown.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("import")
        .setDescription("Import environment JSON or memory Markdown as a draft.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("branch").setDescription("Base branch").setRequired(true),
        )
        .addAttachmentOption((option) =>
          option.setName("environment").setDescription("Environment JSON file"),
        )
        .addAttachmentOption((option) =>
          option.setName("memory").setDescription("Memory Markdown file"),
        ),
    );
  await client.application?.commands.set([command.toJSON()]);
}

export async function handleSetupInteraction(input: {
  interaction: Interaction;
  store: SetupStore;
  orchestrator: SetupOrchestrator;
}): Promise<boolean> {
  const { interaction, store, orchestrator } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    await handleSetupCommand(interaction, store, orchestrator);
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith(SETUP_CUSTOM_ID_PREFIX)) {
    await handleSetupButton(interaction, store);
    return true;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(SETUP_CUSTOM_ID_PREFIX)
  ) {
    await handleSetupModal(interaction, store);
    return true;
  }
  return false;
}

async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
  orchestrator: SetupOrchestrator,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "create" || subcommand === "update") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const model = interaction.options.getString("model") ?? undefined;
      const started = await orchestrator.startSetup({
        repo: requiredStringOption(interaction, "repo"),
        branch: requiredStringOption(interaction, "branch"),
        update: subcommand === "update",
        ...(model ? { model } : {}),
      });
      await interaction.editReply(
        [
          `Setup ${subcommand} started.`,
          `Run: ${started.runId}`,
          `Profile: ${started.profileId}`,
          `Workspace: ${started.workspacePath}`,
        ].join("\n"),
      );
      return;
    }
    if (subcommand === "status" || subcommand === "view") {
      const profile = await store.getProfile(
        requiredStringOption(interaction, "repo"),
        requiredStringOption(interaction, "branch"),
      );
      if (!profile) {
        await interaction.reply({
          content: "Setup profile is missing.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const view = renderSetupProfile(profile);
      await interaction.reply({
        content: view.content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === "edit") {
      const profile = await requireProfileFromOptions(interaction, store);
      if (!profile) return;
      const draft = await store.createDraft(profile.id, interaction.user.id);
      await interaction.reply({
        content: renderDraft(draft).content,
        components: draftComponents(draft),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === "export") {
      const profile = await requireProfileFromOptions(interaction, store);
      if (!profile) return;
      const view = exportProfile(profile);
      await interaction.reply({
        content: view.content,
        files: (view.files ?? []).map(
          (file) =>
            new AttachmentBuilder(Buffer.from(file.content, "utf8"), {
              name: file.name,
            }),
        ),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === "import") {
      await handleImportCommand(interaction, store);
      return;
    }
    await interaction.reply({
      content: `Unknown setup subcommand: ${subcommand}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction, summarizeError(error));
  }
}

async function handleImportCommand(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const profile = await store.getProfile(
    requiredStringOption(interaction, "repo"),
    requiredStringOption(interaction, "branch"),
  );
  if (!profile) {
    await interaction.editReply("Setup profile is missing.");
    return;
  }
  const environmentAttachment = interaction.options.getAttachment("environment");
  const memoryAttachment = interaction.options.getAttachment("memory");
  if (!environmentAttachment && !memoryAttachment) {
    await interaction.editReply("Attach environment JSON, memory Markdown, or both.");
    return;
  }
  const environment = environmentAttachment
    ? await readEnvironmentAttachment(environmentAttachment)
    : undefined;
  const memoryMarkdown = memoryAttachment
    ? await readAttachmentText(memoryAttachment)
    : undefined;
  const draft = await store.createDraft(profile.id, interaction.user.id);
  const parsed = validateSetupProfilePayload({
    environment: environment ?? draft.environment,
    memoryMarkdown: memoryMarkdown ?? draft.memoryMarkdown,
  });
  if (!parsed.ok) {
    const invalidDraft = await store.updateDraft({
      draftId: draft.id,
      validationStatus: "invalid",
      validationMessage: parsed.message,
    });
    await interaction.editReply({
      content: renderDraft(invalidDraft).content,
      components: draftComponents(invalidDraft),
    });
    return;
  }
  const imported = await store.updateDraft({
    draftId: draft.id,
    environment: parsed.value.environment,
    memoryMarkdown: parsed.value.memoryMarkdown,
    validationStatus: "valid",
    validationMessage: "Imported files are valid.",
  });
  await interaction.editReply({
    content: renderDraft(imported).content,
    components: draftComponents(imported),
  });
}

async function handleSetupButton(
  interaction: ButtonInteraction,
  store: SetupStore,
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "Invalid setup action.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const draft = await store.getDraft(parsed.draftId);
  if (!draft) {
    await interaction.reply({
      content: "Draft not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (draft.discordUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the draft owner can edit this setup draft.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (parsed.action === "commands") {
    const checks = checksText(draft);
    if (checks.length > 4000) {
      await interaction.reply({
        content:
          "This draft has too many check commands for a Discord modal. Use /setup export, edit the environment JSON, then /setup import.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(commandsModal(draft));
    return;
  }
  if (parsed.action === "requirements") {
    await interaction.showModal(requirementsModal(draft));
    return;
  }
  if (parsed.action === "memory") {
    if (draft.memoryMarkdown.length > 4000) {
      await interaction.reply({
        content:
          "This setup memory is too large for a Discord modal. Use /setup export, edit the Markdown file, then /setup import.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(memoryModal(draft));
    return;
  }
  if (parsed.action === "validate") {
    const validation = validateSetupProfilePayload({
      environment: draft.environment,
      memoryMarkdown: draft.memoryMarkdown,
    });
    const updated = await store.updateDraft({
      draftId: draft.id,
      validationStatus: validation.ok ? "valid" : "invalid",
      validationMessage: validation.ok ? "Draft is valid." : validation.message,
    });
    await interaction.update({
      content: renderDraft(updated).content,
      components: draftComponents(updated),
    });
    return;
  }
  if (parsed.action === "apply") {
    const result = await store.applyDraft(draft.id);
    if (result.ok) {
      await interaction.update({
        content: renderSetupProfile(result.profile).content,
        components: [],
      });
      return;
    }
    const message =
      result.reason === "conflict"
        ? "Profile changed since this draft was opened. Reopen the editor."
        : `Draft could not be applied: ${result.reason}`;
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }
  if (parsed.action === "discard") {
    await store.discardDraft(draft.id);
    await interaction.update({ content: "Draft discarded.", components: [] });
  }
}

async function handleSetupModal(
  interaction: ModalSubmitInteraction,
  store: SetupStore,
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "Invalid setup modal.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const draft = await store.getDraft(parsed.draftId);
  if (!draft) {
    await interaction.reply({
      content: "Draft not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (draft.discordUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the draft owner can edit this setup draft.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  let environment = draft.environment;
  let memoryMarkdown = draft.memoryMarkdown;
  if (parsed.action === "commands") {
    environment = {
      ...draft.environment,
      install: interaction.fields.getTextInputValue("install"),
      start: interaction.fields.getTextInputValue("start"),
      checks: parseChecks(interaction.fields.getTextInputValue("checks")),
    };
  } else if (parsed.action === "requirements") {
    environment = {
      ...draft.environment,
      requiredEnv: parseLines(interaction.fields.getTextInputValue("requiredEnv")),
      requiredServices: parseLines(
        interaction.fields.getTextInputValue("requiredServices"),
      ),
    };
  } else if (parsed.action === "memory") {
    memoryMarkdown = interaction.fields.getTextInputValue("memoryMarkdown");
  }
  const parsedPayload = validateSetupProfilePayload({
    environment,
    memoryMarkdown,
  });
  const updated = await store.updateDraft({
    draftId: draft.id,
    ...(parsedPayload.ok
      ? {
          environment: parsedPayload.value.environment,
          memoryMarkdown: parsedPayload.value.memoryMarkdown,
        }
      : {}),
    validationStatus: parsedPayload.ok ? "valid" : "invalid",
    validationMessage: parsedPayload.ok ? "Draft is valid." : parsedPayload.message,
  });
  await respondWithDraft(interaction, updated);
}

async function respondWithDraft(
  interaction: ModalSubmitInteraction,
  draft: SetupDraft,
): Promise<void> {
  const response = {
    content: renderDraft(draft).content,
    components: draftComponents(draft),
  };
  if (interaction.message) {
    await interaction.deferUpdate();
    await interaction.message.edit(response);
    return;
  }
  await interaction.reply({
    ...response,
    flags: MessageFlags.Ephemeral,
  });
}

function draftComponents(
  draft: SetupDraft,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("commands", draft.id, "Commands", ButtonStyle.Secondary),
      button("requirements", draft.id, "Env and services", ButtonStyle.Secondary),
      button("memory", draft.id, "Memory", ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("validate", draft.id, "Validate", ButtonStyle.Primary),
      button("apply", draft.id, "Apply", ButtonStyle.Success),
      button("discard", draft.id, "Discard", ButtonStyle.Danger),
    ),
  ];
}

function button(
  action: string,
  draftId: string,
  label: string,
  style: ButtonStyle,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${SETUP_CUSTOM_ID_PREFIX}${action}:${draftId}`)
    .setLabel(label)
    .setStyle(style);
}

function commandsModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SETUP_CUSTOM_ID_PREFIX}commands:${draft.id}`)
    .setTitle("Setup commands")
    .addComponents(
      modalRow("install", "Install command", draft.environment.install, 4000, true),
      modalRow("start", "Start command", draft.environment.start, 4000, false),
      modalRow("checks", "Checks as name=command lines", checksText(draft), 4000, false),
    );
}

function requirementsModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SETUP_CUSTOM_ID_PREFIX}requirements:${draft.id}`)
    .setTitle("Setup requirements")
    .addComponents(
      modalRow("requiredEnv", "Required env names", draft.environment.requiredEnv.join("\n"), 4000, false),
      modalRow(
        "requiredServices",
        "Required services",
        draft.environment.requiredServices.join("\n"),
        4000,
        false,
      ),
    );
}

function memoryModal(draft: SetupDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SETUP_CUSTOM_ID_PREFIX}memory:${draft.id}`)
    .setTitle("Setup memory")
    .addComponents(
      modalRow(
        "memoryMarkdown",
        "Memory Markdown",
        draft.memoryMarkdown.slice(0, 4000),
        4000,
        true,
        TextInputStyle.Paragraph,
      ),
    );
}

function modalRow(
  customId: string,
  label: string,
  value: string,
  maxLength: number,
  required: boolean,
  style: TextInputStyle = TextInputStyle.Paragraph,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setValue(value.slice(0, maxLength))
      .setMaxLength(maxLength)
      .setRequired(required)
      .setStyle(style),
  );
}

async function requireProfileFromOptions(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
) {
  const key = parseSetupProfileKey(
    requiredStringOption(interaction, "repo"),
    requiredStringOption(interaction, "branch"),
  );
  if (!key.ok) {
    await interaction.reply({
      content: key.message,
      flags: MessageFlags.Ephemeral,
    });
    return undefined;
  }
  const profile = await store.getProfile(key.value.repo, key.value.branch);
  if (!profile) {
    await interaction.reply({
      content: "Setup profile is missing.",
      flags: MessageFlags.Ephemeral,
    });
    return undefined;
  }
  return profile;
}

function requiredStringOption(
  interaction: ChatInputCommandInteraction,
  name: string,
): string {
  return interaction.options.getString(name, true);
}

function parseCustomId(
  customId: string,
): { action: string; draftId: string } | undefined {
  if (!customId.startsWith(SETUP_CUSTOM_ID_PREFIX)) return undefined;
  const rest = customId.slice(SETUP_CUSTOM_ID_PREFIX.length);
  const [action, draftId] = rest.split(":");
  if (!action || !draftId) return undefined;
  return { action, draftId };
}

function checksText(draft: SetupDraft): string {
  return Object.entries(draft.environment.checks)
    .map(([name, command]) => `${name}=${command}`)
    .join("\n");
}

function parseChecks(value: string): Record<string, string> {
  const checks: Record<string, string> = {};
  for (const line of value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const command = line.slice(separator + 1).trim();
    checks[name] = command;
  }
  return checks;
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readEnvironmentAttachment(
  attachment: Attachment,
): Promise<SetupEnvironment> {
  const text = await readAttachmentText(attachment);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new Error("Environment attachment must be valid JSON.");
  }
  const environment = validateSetupEnvironment(parsedJson);
  if (!environment.ok) throw new Error(environment.message);
  return environment.value;
}

async function readAttachmentText(attachment: Attachment): Promise<string> {
  if (attachment.size > 1024 * 1024) {
    throw new Error(`Attachment ${attachment.name} is too large. Max size is 1MB.`);
  }
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch attachment ${attachment.name}.`);
  }
  return response.text();
}

async function replyWithError(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  if (interaction.deferred) {
    await interaction.editReply(`Setup failed: ${message}`);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content: `Setup failed: ${message}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: `Setup failed: ${message}`,
    flags: MessageFlags.Ephemeral,
  });
}
