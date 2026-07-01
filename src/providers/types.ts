export type PiApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface PiProviderTransport {
  baseUrl?: string;
  api?: PiApiType;
  headers?: Record<string, string>;
}

export interface PiProviderDefinition {
  id: string;
  models: string[];
  apiKey?: string;
  transport?: PiProviderTransport;
}

export interface ProviderRegistry {
  providers: PiProviderDefinition[];
}

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

export interface MaterializePiSessionConfigInput {
  workspacePath: string;
  repo: string;
  model: string;
  registry: ProviderRegistry;
}

export interface MaterializePiSessionConfigResult {
  agentDir?: string;
  wroteModelsJson: boolean;
}
