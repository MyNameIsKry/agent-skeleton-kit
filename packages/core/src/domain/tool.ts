import type { JsonValue } from "./json.js";

export type LogFields = Record<string, unknown>;
export type LogFn = (fields: LogFields, message: string) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: LogFields): Logger;
}

export type TenantRecord = Record<string, unknown>;

/**
 * Persistence for tool handlers. Every operation is scoped to the calling tenant by the
 * implementation; handlers cannot name a tenant.
 */
export interface TenantDataStore {
  insert(collection: string, doc: TenantRecord): Promise<{ id: string }>;
  findOne(collection: string, filter: TenantRecord): Promise<TenantRecord | null>;
  find(collection: string, filter?: TenantRecord, limit?: number): Promise<TenantRecord[]>;
  update(collection: string, filter: TenantRecord, patch: TenantRecord): Promise<number>;
}

/** Everything a handler receives besides its arguments. No database or queue handles. */
export interface ToolContext {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly data: TenantDataStore;
}

/** A handler result must be JSON-serializable. Return `{ ok: false, reason }` for expected failures. */
export type ToolResult = JsonValue;

/** Contract for tenant tool handlers. The module must default-export a function of this type. */
export type ToolHandler<Args = Record<string, unknown>, Result = ToolResult> = (
  args: Args,
  ctx: ToolContext,
) => Promise<Result>;
