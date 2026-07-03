import {
  buildCustomId,
  parseCustomId,
  selectMenuRow,
  viewWithRows,
  type SelectMenuOption,
} from "../discord/ui/index.js";
import type { SetupProfile } from "./profile.js";

export const SETUP_PROFILE_SELECT_MAX = 25;

export type SetupProfileAction = "status" | "view" | "edit" | "export";

const ACTION_TITLES: Record<SetupProfileAction, string> = {
  status: "Setup status",
  view: "View setup profile",
  edit: "Edit setup profile",
  export: "Export setup profile",
};

const ACTION_PROMPTS: Record<SetupProfileAction, string> = {
  status: "Choose a repository and branch to inspect setup status.",
  view: "Choose a repository and branch to view the active profile.",
  edit: "Choose a repository and branch to open the draft editor.",
  export: "Choose a repository and branch to export environment and memory files.",
};

export function profileSelectCustomId(
  action: SetupProfileAction,
  userId: string,
): string {
  return buildCustomId("setup", "sel", action, userId);
}

export function parseProfileSelectCustomId(
  raw: string,
): { action: SetupProfileAction; userId: string } | null {
  const parsed = parseCustomId(raw);
  if (!parsed || parsed.ns !== "setup" || parsed.action !== "sel") return null;
  const [action, userId] = parsed.params;
  if (!action || !userId) return null;
  if (
    action !== "status" &&
    action !== "view" &&
    action !== "edit" &&
    action !== "export"
  ) {
    return null;
  }
  return { action, userId };
}

export function profileOptions(profiles: SetupProfile[]): SelectMenuOption[] {
  return profiles.map((profile) => ({
    label: `${profile.repo} @ ${profile.branch}`.slice(0, 100),
    value: profile.id,
    description: `${profile.status} · rev ${profile.revision}`.slice(0, 100),
  }));
}

export function buildProfilePickerView(
  action: SetupProfileAction,
  userId: string,
  profiles: SetupProfile[],
) {
  let body = ACTION_PROMPTS[action];
  if (profiles.length === SETUP_PROFILE_SELECT_MAX) {
    body = `${body}\n\nShowing first ${SETUP_PROFILE_SELECT_MAX} profiles.`;
  }
  const row = selectMenuRow(
    profileSelectCustomId(action, userId),
    "Choose a setup profile",
    profileOptions(profiles),
  );
  return viewWithRows(ACTION_TITLES[action], body, [row]);
}
