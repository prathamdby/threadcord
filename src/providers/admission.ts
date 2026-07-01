import type { PiHostConfig } from "./types.js";
import { parseModelRef } from "./model-ref.js";

export function assertModelAllowed(model: string, config: PiHostConfig): void {
  if (!config.allowedModels.includes(model)) {
    throw new Error(`Model ${model} is not allowed.`);
  }
}

export function validateAllowedModelRef(modelRef: string): void {
  parseModelRef(modelRef);
}
