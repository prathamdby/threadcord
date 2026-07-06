import { buildCustomId, confirmView, parseCustomId } from "../discord/ui/index.js";
import type { SetupProfile } from "./profile.js";
import {
  buildProfilePickerView,
  profileSelectCustomId,
} from "./profile-select.js";

export function deleteConfirmCustomId(profileId: string, userId: string): string {
  return buildCustomId("setup", "del", "confirm", profileId, userId);
}

export function deleteCancelCustomId(profileId: string, userId: string): string {
  return buildCustomId("setup", "del", "cancel", profileId, userId);
}

export function parseDeleteButtonCustomId(
  raw: string,
): { step: "confirm" | "cancel"; profileId: string; userId: string } | null {
  const parsed = parseCustomId(raw);
  if (!parsed || parsed.ns !== "setup" || parsed.action !== "del") return null;
  const [step, profileId, userId] = parsed.params;
  if (!step || !profileId || !userId) return null;
  if (step !== "confirm" && step !== "cancel") return null;
  return { step, profileId, userId };
}

export function renderDeleteConfirmView(profile: SetupProfile, userId: string) {
  const prompt = [
    `Delete setup profile **${profile.repo}** @ **${profile.branch}**?`,
    "",
    "This removes the profile, setup runs, and drafts. Tasks for this repo/branch will need `/setup create` again.",
    profile.status === "running" || profile.status === "updating"
      ? "This profile is currently running or updating; wait for it to finish before deleting."
      : undefined,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
  return confirmView(
    prompt,
    deleteConfirmCustomId(profile.id, userId),
    deleteCancelCustomId(profile.id, userId),
  );
}

export function renderDeleteCancelledPicker(
  userId: string,
  profiles: SetupProfile[],
) {
  return buildProfilePickerView("delete", userId, profiles);
}

export { profileSelectCustomId };