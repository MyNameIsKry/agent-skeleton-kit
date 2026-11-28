/**
 * A ToolContext for unit-testing tenant tool handlers without the runtime. Tenant code cannot
 * create a TenantContext (tenant-isolation rule 1), so this helper builds one through a
 * one-tenant registry and returns the context a handler would receive.
 */
import { InMemoryTenantRegistry } from "../application/tenants/in-memory-tenant-registry.js";
import type { Logger, LogFn } from "../domain/ports.js";
import type { TenantConfig } from "../domain/tenant.js";
import type { ToolContext } from "../domain/tool.js";
import { InMemoryTenantDataStoreFactory } from "./in-memory-tenant-data-store.js";

export interface TestToolContextOptions {
  /** Default "test-tenant". */
  tenantId?: string;
  /** Default "test-session". */
  sessionId?: string;
  /** Default: a signal that never aborts. */
  signal?: AbortSignal;
  /** Default: a logger that drops everything. */
  logger?: Logger;
  /** Pass one factory to several contexts to share records, or to inspect `records`. */
  dataStores?: InMemoryTenantDataStoreFactory;
}

const drop: LogFn = () => undefined;
const silentLogger: Logger = { debug: drop, info: drop, warn: drop, error: drop, child: () => silentLogger };

export function createTestToolContext(options: TestToolContextOptions = {}): ToolContext {
  const tenantId = options.tenantId ?? "test-tenant";
  const config: TenantConfig = {
    id: tenantId,
    displayName: tenantId,
    description: tenantId,
    systemPrompt: "",
    retrieval: { topK: 5, minScore: 0.6 },
    chunking: { maxTokens: 400, overlap: 50 },
    tools: [],
    rootDir: "/",
  };
  const ctx = new InMemoryTenantRegistry([config]).resolve(tenantId);
  const dataStores = options.dataStores ?? new InMemoryTenantDataStoreFactory();
  return Object.freeze({
    tenantId,
    sessionId: options.sessionId ?? "test-session",
    logger: options.logger ?? silentLogger,
    signal: options.signal ?? new AbortController().signal,
    data: dataStores.forTenant(ctx),
  });
}
