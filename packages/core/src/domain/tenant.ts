import type { DeepReadonly } from "./freeze.js";
import type { JsonSchema } from "./json.js";

/** Tenant ids double as directory names, so they are restricted to a safe, lowercase alphabet. */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Tool names are snake_case and fit the function-name limits of OpenAI-compatible APIs. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface RetrievalSettings {
  topK: number;
  minScore: number;
}

export interface ChunkingSettings {
  maxTokens: number;
  overlap: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Absolute, symlink-resolved path of the handler module. Never sent to clients or the model. */
  handlerPath: string;
}

export interface TenantConfigData {
  id: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  retrieval: RetrievalSettings;
  chunking: ChunkingSettings;
  tools: ToolDefinition[];
  /** Absolute, symlink-resolved tenant directory. */
  rootDir: string;
}

/** A validated tenant config. Deep-frozen by the loader. */
export type TenantConfig = DeepReadonly<TenantConfigData>;

/**
 * The only way tenant identity travels through the core. Created by the tenant registry
 * from a validated config, frozen, and passed explicitly to every tenant-scoped operation.
 */
export type TenantContext = Readonly<{
  tenantId: string;
  config: TenantConfig;
}>;

/** Public view of a tenant: no prompts, no paths. */
export type TenantSummary = DeepReadonly<{
  id: string;
  displayName: string;
  description: string;
  tools: { name: string; description: string }[];
}>;
