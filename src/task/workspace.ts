import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseGitHubRepository } from "./policy.js";
import type { TaskRecord } from "../types.js";

export function checkoutPathForTask(task: TaskRecord): string {
  const repo = parseGitHubRepository(task.repo);
  if (!repo.ok) {
    throw new Error(
      "Task repository is invalid. Refusing to derive checkout path.",
    );
  }

  const checkoutPath = join(task.workspacePath, basename(task.repo));
  if (!isPathContainedIn(task.workspacePath, checkoutPath)) {
    throw new Error("Checkout path must stay inside the task workspace.");
  }

  return checkoutPath;
}

export function isPathContainedIn(parentPath: string, childPath: string): boolean {
  const fromParent = relative(resolve(parentPath), resolve(childPath));
  return (
    fromParent !== "" &&
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

export function hasTaskWorkspaceShape(
  workspaceRoot: string,
  candidatePath: string,
): boolean {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedCandidate = resolveCandidatePath(candidatePath);
  const fromRoot = relative(resolvedRoot, resolvedCandidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return false;
  }
  const segments = fromRoot.split(sep);
  return segments.length === 1 && segments[0]!.length > 0;
}

function resolveCandidatePath(candidatePath: string): string {
  return resolve(candidatePath);
}

export type WorkspaceDeletionDecision =
  | { action: "delete"; resolvedPath: string }
  | { action: "skip"; reason: string };

export async function decideWorkspaceDeletion(
  candidatePath: string,
  workspaceRoot: string,
): Promise<WorkspaceDeletionDecision> {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedCandidate = resolveCandidatePath(candidatePath);

  if (resolvedCandidate === resolvedRoot) {
    return { action: "skip", reason: "workspace root cannot be deleted" };
  }

  if (!isPathContainedIn(resolvedRoot, resolvedCandidate)) {
    return { action: "skip", reason: "path is outside workspace root" };
  }

  if (!hasTaskWorkspaceShape(workspaceRoot, resolvedCandidate)) {
    return { action: "skip", reason: "path does not match task workspace shape" };
  }

  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch {
    // Root missing on disk is unexpected; resolved paths still bound containment.
  }

  let canonicalCandidate = resolvedCandidate;
  try {
    canonicalCandidate = await realpath(resolvedCandidate);
  } catch {
    // Missing workspaces cannot be realpathed; map through the resolved root so
    // containment stays consistent when the root itself is symlinked (/var).
    const fromResolvedRoot = relative(resolvedRoot, resolvedCandidate);
    canonicalCandidate = join(canonicalRoot, fromResolvedRoot);
  }

  if (canonicalCandidate === canonicalRoot) {
    return { action: "skip", reason: "workspace root cannot be deleted" };
  }

  if (!isPathContainedIn(canonicalRoot, canonicalCandidate)) {
    return { action: "skip", reason: "path resolves outside workspace root" };
  }

  if (!hasTaskWorkspaceShape(canonicalRoot, canonicalCandidate)) {
    return { action: "skip", reason: "path does not match task workspace shape" };
  }

  return { action: "delete", resolvedPath: canonicalCandidate };
}
