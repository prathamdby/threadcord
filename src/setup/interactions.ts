import { setTimeout as delay } from "node:timers/promises";
import {
  AttachmentBuilder,
  MessageFlags,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  ensureDeferred,
  infoView,
  replyWithError,
  respond,
} from "../discord/ui/index.js";
import { clampDiscordContent } from "../discord/limits.js";
import { summarizeError } from "../util/redact.js";
import type { AppConfig } from "../config.js";
import {
  type SetupEnvironment,
  parseSetupProfileKey,
  validateSetupEnvironment,
  validateSetupProfilePayload,
} from "./profile.js";
import {
  parseSetupWizardCustomId,
  pendingFromRunModal,
  setupCreateRunModal,
  type PendingSetupWizard,
} from "./create-flow.js";
import {
  checksTooLargeForModal,
  commandsModal,
  memoryModal,
  memoryTooLargeForModal,
  parseDraftCustomId,
  renderDiscardConfirmView,
  renderDraftView,
  requirementsModal,
} from "./draft-ui.js";
import { openSetupRunThread } from "./discord-session.js";
import {
  buildProfilePickerView,
  parseProfileSelectCustomId,
  SETUP_PROFILE_SELECT_MAX,
  type SetupProfileAction,
} from "./profile-select.js";
import {
  exportProfile,
  renderSetupProfile,
  renderSetupStatus,
} from "./renderer.js";
import type { SetupOrchestrator } from "./orchestrator.js";
import type { SetupStore } from "./store.js";

export async function handleSetupInteraction(input: {
  interaction: Interaction;
  store: SetupStore;
  orchestrator: SetupOrchestrator;
  config: AppConfig;
}): Promise<boolean> {
  const { interaction, store, orchestrator, config } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    await handleSetupCommand(interaction, store, orchestrator, config);
    return true;
  }
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("setup:")
  ) {
    await handleSetupProfileSelect(interaction, store);
    return true;
  }
  if (
    interaction.isButton() &&
    interaction.customId.startsWith("setup:")
  ) {
    await handleSetupButton(interaction, store);
    return true;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("setup:")
  ) {
    await handleSetupModal(interaction, store, orchestrator);
    return true;
  }
  return false;
}

async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
  orchestrator: SetupOrchestrator,
  config: AppConfig,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "create" || subcommand === "update") {
      await interaction.showModal(
        setupCreateRunModal(
          interaction.user.id,
          subcommand,
          undefined,
          undefined,
          undefined,
          config.allowedModels,
          config.defaultModel,
        ),
      );
      return;
    }
    if (
      subcommand === "status" ||
      subcommand === "view" ||
      subcommand === "edit" ||
      subcommand === "export"
    ) {
      await showProfilePicker(interaction, store, subcommand);
      return;
    }
    if (subcommand === "import") {
      await handleImportCommand(interaction, store);
      return;
    }
    await replyWithError(
      interaction,
      "validation",
      `Unknown setup subcommand: ${subcommand}`,
    );
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

async function showProfilePicker(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
  action: SetupProfileAction,
): Promise<void> {
  await ensureDeferred(interaction);
  const profiles = await store.listProfiles(SETUP_PROFILE_SELECT_MAX);
  if (profiles.length === 0) {
    await replyWithError(
      interaction,
      "validation",
      "No setup profiles found. Run `/setup create` first.",
    );
    return;
  }
  await respond(
    interaction,
    buildProfilePickerView(action, interaction.user.id, profiles),
  );
}

async function handleSetupProfileSelect(
  interaction: StringSelectMenuInteraction,
  store: SetupStore,
): Promise<void> {
  const parsed = parseProfileSelectCustomId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid setup profile picker.");
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This picker belongs to another user.",
    );
    return;
  }
  const profileId = interaction.values[0];
  if (!profileId) {
    await replyWithError(interaction, "validation", "Select a setup profile.");
    return;
  }
  await interaction.deferUpdate();
  const profile = await store.getProfileById(profileId);
  if (!profile) {
    await replyWithError(
      interaction,
      "validation",
      "Setup profile is missing.",
    );
    return;
  }
  try {
    if (parsed.action === "status") {
      const run = profile.lastRunId
        ? await store.getRun(profile.lastRunId)
        : undefined;
      await respond(
        interaction,
        renderSetupStatus({
          profile,
          ...(run ? { run } : {}),
        }),
      );
      return;
    }
    if (parsed.action === "view") {
      await respond(interaction, renderSetupProfile(profile));
      return;
    }
    if (parsed.action === "edit") {
      const draft = await store.createDraft(profile.id, interaction.user.id);
      await respond(interaction, renderDraftView(draft));
      return;
    }
    if (parsed.action === "export") {
      const bundle = exportProfile(profile);
      await respondWithExport(interaction, bundle);
      return;
    }
    await replyWithError(interaction, "validation", "Unknown setup action.");
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

async function handleImportCommand(
  interaction: ChatInputCommandInteraction,
  store: SetupStore,
): Promise<void> {
  await ensureDeferred(interaction);
  const profile = await requireProfileFromOptions(interaction, store);
  if (!profile) return;
  const environmentAttachment =
    interaction.options.getAttachment("environment");
  const memoryAttachment = interaction.options.getAttachment("memory");
  if (!environmentAttachment && !memoryAttachment) {
    await replyWithError(
      interaction,
      "validation",
      "Attach environment JSON, memory Markdown, or both.",
    );
    return;
  }
  try {
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
      await respond(interaction, renderDraftView(invalidDraft));
      return;
    }
    const imported = await store.updateDraft({
      draftId: draft.id,
      environment: parsed.value.environment,
      memoryMarkdown: parsed.value.memoryMarkdown,
      validationStatus: "valid",
      validationMessage: "Imported files are valid.",
    });
    await respond(interaction, renderDraftView(imported));
  } catch (error) {
    await replyWithError(interaction, "validation", summarizeError(error));
  }
}

async function handleSetupButton(
  interaction: ButtonInteraction,
  store: SetupStore,
): Promise<void> {
  const parsed = parseDraftCustomId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid setup action.");
    return;
  }

  if (parsed.action === "discard" && parsed.confirmStep === "confirm") {
    const draft = await store.getDraft(parsed.draftId);
    if (!draft) {
      await replyWithError(interaction, "validation", "Draft not found.");
      return;
    }
    if (draft.discordUserId !== interaction.user.id) {
      await replyWithError(
        interaction,
        "rejection",
        "Only the draft owner can edit this setup draft.",
      );
      return;
    }
    await interaction.deferUpdate();
    await store.discardDraft(parsed.draftId);
    await interaction.editReply(
      infoView("Draft discarded", "The setup draft was discarded."),
    );
    return;
  }

  if (parsed.action === "discard" && parsed.confirmStep === "cancel") {
    const draft = await store.getDraft(parsed.draftId);
    if (!draft) {
      await replyWithError(interaction, "validation", "Draft not found.");
      return;
    }
    if (draft.discordUserId !== interaction.user.id) {
      await replyWithError(
        interaction,
        "rejection",
        "Only the draft owner can edit this setup draft.",
      );
      return;
    }
    await interaction.update(renderDraftView(draft));
    return;
  }

  const draft = await store.getDraft(parsed.draftId);
  if (!draft) {
    await replyWithError(interaction, "validation", "Draft not found.");
    return;
  }
  if (draft.discordUserId !== interaction.user.id) {
    await replyWithError(
      interaction,
      "rejection",
      "Only the draft owner can edit this setup draft.",
    );
    return;
  }

  if (parsed.action === "commands") {
    if (checksTooLargeForModal(draft)) {
      await replyWithError(
        interaction,
        "validation",
        "This draft has too many check commands for a Discord modal. Use /setup export, edit the environment JSON, then /setup import.",
      );
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
    if (memoryTooLargeForModal(draft)) {
      await replyWithError(
        interaction,
        "validation",
        "This setup memory is too large for a Discord modal. Use /setup export, edit the Markdown file, then /setup import.",
      );
      return;
    }
    await interaction.showModal(memoryModal(draft));
    return;
  }
  if (parsed.action === "validate") {
    await interaction.deferUpdate();
    try {
      const validation = validateSetupProfilePayload({
        environment: draft.environment,
        memoryMarkdown: draft.memoryMarkdown,
      });
      const updated = await store.updateDraft({
        draftId: draft.id,
        validationStatus: validation.ok ? "valid" : "invalid",
        validationMessage: validation.ok
          ? "Draft is valid."
          : validation.message,
      });
      await interaction.editReply(renderDraftView(updated));
    } catch (error) {
      await replyWithError(interaction, "internal", summarizeError(error));
    }
    return;
  }
  if (parsed.action === "apply") {
    await interaction.deferUpdate();
    try {
      const result = await store.applyDraft(draft.id);
      if (result.ok) {
        await interaction.editReply(renderSetupProfile(result.profile));
        return;
      }
      const message =
        result.reason === "conflict"
          ? "Profile changed since this draft was opened. Reopen the editor."
          : `Draft could not be applied: ${result.reason}`;
      await replyWithError(interaction, "rejection", message);
    } catch (error) {
      await replyWithError(interaction, "internal", summarizeError(error));
    }
    return;
  }
  if (parsed.action === "discard") {
    await interaction.update(renderDiscardConfirmView(draft));
    return;
  }
  await replyWithError(interaction, "validation", "Unknown setup action.");
}

async function handleSetupModal(
  interaction: ModalSubmitInteraction,
  store: SetupStore,
  orchestrator?: SetupOrchestrator,
): Promise<void> {
  const wizard = parseSetupWizardCustomId(interaction.customId);
  if (wizard?.kind === "create-run") {
    if (!orchestrator) {
      await replyWithError(
        interaction,
        "internal",
        "Setup orchestrator unavailable.",
      );
      return;
    }
    if (interaction.user.id !== wizard.userId) {
      await replyWithError(
        interaction,
        "rejection",
        "This setup dialog belongs to another user.",
      );
      return;
    }
    const repo = interaction.fields.getTextInputValue("repo").trim();
    const branch = interaction.fields.getTextInputValue("branch").trim();
    const skillsRaw = interaction.fields.getTextInputValue("skills");
    const key = parseSetupProfileKey(repo, branch);
    if (!key.ok) {
      await replyWithError(interaction, "validation", key.message);
      return;
    }
    if (wizard.mode === "create") {
      const model = interaction.fields.getStringSelectValues("model")[0];
      if (!model) {
        await replyWithError(interaction, "validation", "Select a model.");
        return;
      }
      const pending = pendingFromRunModal({
        mode: "create",
        repo: key.value.repo,
        branch: key.value.branch,
        skillsRaw,
        model,
      });
      await interaction.deferReply();
      try {
        await finishSetupFromWizard(
          interaction,
          store,
          orchestrator,
          pending,
          { mode: "create", skills: pending.skills },
        );
      } catch (error) {
        try {
          await interaction.editReply(
            clampDiscordContent(`Setup failed: ${summarizeError(error)}`),
          );
        } catch (editError) {
          console.error(
            "[threadcord] setup wizard failure editReply failed",
            editError,
          );
        }
      }
      return;
    }
    const install = interaction.fields.getTextInputValue("install");
    const checks = interaction.fields.getTextInputValue("checks");
    const pending = pendingFromRunModal({
      mode: "update",
      repo: key.value.repo,
      branch: key.value.branch,
      skillsRaw,
      install,
      checksRaw: checks,
    });
    if (!pending.install?.trim()) {
      await replyWithError(
        interaction,
        "validation",
        "Install command is required.",
      );
      return;
    }
    await interaction.deferReply();
    const existingProfile = await store.getProfile(
      key.value.repo,
      key.value.branch,
    );
    if (!existingProfile) {
      await replyWithError(
        interaction,
        "validation",
        "Setup profile is missing. Run `/setup create` before updating.",
      );
      return;
    }
    const envCheck = validateSetupEnvironment({
      install: pending.install,
      start: existingProfile.environment.start ?? pending.start ?? "",
      checks: pending.checks ?? {},
      requiredEnv: existingProfile.environment.requiredEnv ?? [],
      requiredServices: existingProfile.environment.requiredServices ?? [],
      ...(pending.skills.length > 0 ? { skills: pending.skills } : {}),
    });
    if (!envCheck.ok) {
      await replyWithError(interaction, "validation", envCheck.message);
      return;
    }
    try {
      await finishSetupFromWizard(
        interaction,
        store,
        orchestrator,
        pending,
        {
          mode: "update",
          install: envCheck.value.install,
          checks: envCheck.value.checks,
          skills: envCheck.value.skills ?? [],
        },
      );
    } catch (error) {
      try {
        await interaction.editReply(
          clampDiscordContent(`Setup failed: ${summarizeError(error)}`),
        );
      } catch (editError) {
        console.error(
          "[threadcord] setup wizard failure editReply failed",
          editError,
        );
      }
    }
    return;
  }

  const parsed = parseDraftCustomId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid setup modal.");
    return;
  }
  const draft = await store.getDraft(parsed.draftId);
  if (!draft) {
    await replyWithError(interaction, "validation", "Draft not found.");
    return;
  }
  if (draft.discordUserId !== interaction.user.id) {
    await replyWithError(
      interaction,
      "rejection",
      "Only the draft owner can edit this setup draft.",
    );
    return;
  }
  let environment = draft.environment;
  let memoryMarkdown = draft.memoryMarkdown;
  if (parsed.action === "commands") {
    const skillsField = interaction.fields.getTextInputValue("skills");
    const skillsLines = skillsField
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    environment = {
      ...draft.environment,
      install: interaction.fields.getTextInputValue("install"),
      start: interaction.fields.getTextInputValue("start"),
      checks: parseChecks(interaction.fields.getTextInputValue("checks")),
      ...(skillsLines.length > 0 ? { skills: skillsLines } : {}),
    };
    if (skillsLines.length === 0) {
      delete environment.skills;
    }
  } else if (parsed.action === "requirements") {
    environment = {
      ...draft.environment,
      requiredEnv: parseLines(
        interaction.fields.getTextInputValue("requiredEnv"),
      ),
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
  await ensureDeferred(interaction);
  try {
    const updated = await store.updateDraft({
      draftId: draft.id,
      environment: parsedPayload.ok
        ? parsedPayload.value.environment
        : environment,
      memoryMarkdown: parsedPayload.ok
        ? parsedPayload.value.memoryMarkdown
        : memoryMarkdown,
      validationStatus: parsedPayload.ok ? "valid" : "invalid",
      validationMessage: parsedPayload.ok
        ? "Draft is valid."
        : parsedPayload.message,
    });
    await respond(interaction, renderDraftView(updated));
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

async function respondWithExport(
  interaction: StringSelectMenuInteraction | ChatInputCommandInteraction,
  bundle: ReturnType<typeof exportProfile>,
): Promise<void> {
  const payload = {
    components: bundle.view.components,
    flags: bundle.view.flags | MessageFlags.Ephemeral,
    files: bundle.files.map(
      (file) =>
        new AttachmentBuilder(Buffer.from(file.content, "utf8"), {
          name: file.name,
        }),
    ),
  };
  if (interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
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
    await replyWithError(interaction, "validation", key.message);
    return undefined;
  }
  const profile = await store.getProfile(key.value.repo, key.value.branch);
  if (!profile) {
    await replyWithError(interaction, "validation", "Setup profile is missing.");
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
    throw new Error(
      `Attachment ${attachment.name} is too large. Max size is 1MB.`,
    );
  }
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(attachment.url);
    } catch (error) {
      errors.push(`Attempt ${attempt}: ${summarizeError(error)}`);
      if (attempt < 2) await delay(250);
      continue;
    }
    if (response.ok) return response.text();
    const error = new Error(
      `Failed to fetch attachment ${attachment.name}. HTTP ${response.status}.`,
    );
    if (response.status < 500 && response.status !== 429) throw error;
    errors.push(`Attempt ${attempt}: ${error.message}`);
    if (attempt < 2) await delay(250);
  }
  throw new Error(
    `Failed to fetch attachment ${attachment.name}. ${errors.join("; ")}`,
  );
}

type SetupWizardPreRunPatch =
  | { mode: "create"; skills: string[] }
  | {
      mode: "update";
      install: string;
      checks: Record<string, string>;
      skills: string[];
    };

async function finishSetupFromWizard(
  interaction: ModalSubmitInteraction,
  store: SetupStore,
  orchestrator: SetupOrchestrator,
  pending: PendingSetupWizard,
  patch: SetupWizardPreRunPatch,
): Promise<void> {
  const actionLabel = pending.update ? "update" : "create";
  const started = await orchestrator.startSetup({
    repo: pending.repo,
    branch: pending.branch,
    update: pending.update,
    ...(pending.model ? { model: pending.model } : {}),
  });
  if (patch.mode === "create") {
    await store.patchEnvironmentWhileRunning(started.profileId, {
      skills: patch.skills,
    });
  } else {
    await store.patchEnvironmentWhileRunning(started.profileId, {
      install: patch.install,
      checks: patch.checks,
      skills: patch.skills,
    });
  }
  const run = await store.getRun(started.runId);
  const model = run?.model ?? pending.model ?? "default";
  let threadOpened = false;
  let threadId: string | undefined;
  let replyAnchorFailed = false;
  try {
    const anchor = await interaction.fetchReply();
    const threadRef = await openSetupRunThread({
      anchorMessage: anchor,
      store,
      runId: started.runId,
      repo: started.repo,
      branch: started.branch,
      model,
      actionLabel,
    });
    if (threadRef) {
      orchestrator.registerSetupThread(started.runId, threadRef);
      threadOpened = true;
      threadId = threadRef.id;
    }
  } catch (error) {
    console.error("[threadcord] setup thread creation failed", error);
    replyAnchorFailed = true;
  }
  void orchestrator.dispatchSetupAgent(started);
  const skillsNote =
    patch.skills.length > 0
      ? `Skills (${patch.skills.length} link(s)) install after install on profile save and on each task's first turn.`
      : undefined;
  const replyBody = clampDiscordContent(
    [
      `Setup ${actionLabel} started.`,
      `Run: ${started.runId}`,
      threadOpened && threadId
        ? `Live log: <#${threadId}>`
        : `Profile: ${started.profileId} (no Discord thread; watch server logs).`,
      replyAnchorFailed
        ? "Could not attach a Discord thread to this reply; watch server logs."
        : undefined,
      skillsNote,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  );
  try {
    await interaction.editReply(replyBody);
  } catch (error) {
    console.error("[threadcord] setup wizard editReply failed", error);
  }
}
