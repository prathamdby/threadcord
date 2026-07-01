export interface PiModelsJson {
  providers: Record<string, PiModelsJsonProviderEntry>;
}

export interface PiModelsJsonProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Array<{ id: string }>;
}

export interface PiHostConfig {
  /** Derived from configured Pi providers at startup; not an operator env list. */
  allowedModels: string[];
  defaultModel: string;
  modelsJson?: PiModelsJson;
}

export interface MaterializePiSessionConfigInput {
  workspacePath: string;
  repo: string;
  model: string;
  piConfig: PiHostConfig;
}

export interface MaterializePiSessionConfigResult {
  agentDir?: string;
  wroteModelsJson: boolean;
}

export interface LoadPiConfigInput {
  defaultModel?: string;
  modelsJsonRaw?: string;
  env?: NodeJS.ProcessEnv;
}
