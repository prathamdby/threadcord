export interface PendingTaskCreate {
  repo: string;
  branch: string;
  instruction: string;
  model: string;
}

export function pendingFromTaskCreateModal(input: {
  repo: string;
  branch: string;
  model: string;
  instruction: string;
}): PendingTaskCreate {
  return {
    repo: input.repo.trim(),
    branch: input.branch.trim(),
    model: input.model.trim(),
    instruction: input.instruction.trim(),
  };
}
