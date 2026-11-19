import { ConfigurationError, TenantNotFoundError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { TenantRegistry } from "../../domain/ports.js";
import type { TenantConfig, TenantContext, TenantSummary } from "../../domain/tenant.js";

/**
 * Holds validated tenant configs and hands out frozen TenantContexts.
 * This is the only place a TenantContext is created.
 */
export class InMemoryTenantRegistry implements TenantRegistry {
  readonly #contexts: ReadonlyMap<string, TenantContext>;
  readonly #summaries: readonly TenantSummary[];

  constructor(configs: readonly TenantConfig[]) {
    const contexts = new Map<string, TenantContext>();
    const duplicates = new Set<string>();

    for (const config of configs) {
      if (contexts.has(config.id)) duplicates.add(config.id);
      contexts.set(config.id, Object.freeze({ tenantId: config.id, config: deepFreeze(config) }));
    }
    if (duplicates.size > 0) {
      throw new ConfigurationError(
        "Duplicate tenant ids:",
        [...duplicates].map((id) => `${id}: tenant id must be unique`),
      );
    }

    this.#contexts = contexts;
    this.#summaries = deepFreeze(
      [...contexts.values()]
        .map(({ config }) => ({
          id: config.id,
          displayName: config.displayName,
          description: config.description,
          tools: config.tools.map((tool) => ({ name: tool.name, description: tool.description })),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  list(): readonly TenantSummary[] {
    return this.#summaries;
  }

  resolve(tenantId: string): TenantContext {
    const context = this.#contexts.get(tenantId);
    if (context === undefined) throw new TenantNotFoundError(tenantId);
    return context;
  }
}
