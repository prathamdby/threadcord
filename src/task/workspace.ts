import { isAbsolute, join, relative, resolve } from "node:path";
import { parseGitHubRepository } from "./policy.js";
import type { TaskRecord } from "../types.js";

export function checkoutPathForTask(task: TaskRecord): string {
  const repo = parseGitHubRepository(task.repo);
  if (!repo.ok) {
    throw new Error(
      "Task repository is invalid. Refusing to derive checkout path.",
    );
  }

  const checkoutPath = join(task.workspacePath, repo.name);
  if (!isPathInside(task.workspacePath, checkoutPath)) {
    throw new Error("Checkout path must stay inside the task workspace.");
  }

  return checkoutPath;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const fromParent = relative(resolve(parentPath), resolve(childPath));
  return (
    fromParent === "" ||
    (!fromParent.startsWith("..") && !isAbsolute(fromParent))
  );
}
