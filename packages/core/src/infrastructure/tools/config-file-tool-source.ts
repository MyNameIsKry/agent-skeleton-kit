/**
 * Tools declared in each tenant's tenant.yaml, with the handlers and validators the loader
 * prepared (design.md section 4). Received at wiring time in main.*.ts, so handlers and
 * validators never travel through the TenantContext.
 */
import type { RunnableTool, ToolSource } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import type { LoadedTenant } from "../../domain/tool.js";

export class ConfigFileToolSource implements ToolSource {
  readonly #byTenant: ReadonlyMap<string, readonly RunnableTool[]>;

  constructor(tenants: readonly LoadedTenant[]) {
    const byTenant = new Map<string, readonly RunnableTool[]>();
    for (const tenant of tenants) {
      byTenant.set(
        tenant.config.id,
        Object.freeze(
          [...tenant.tools.values()].map((tool) =>
            Object.freeze({
              spec: Object.freeze({
                name: tool.definition.name,
                description: tool.definition.description,
                parameters: tool.definition.parameters,
              }),
              validateArgs: tool.validateArgs,
              run: tool.handler,
            }),
          ),
        ),
      );
    }
    this.#byTenant = byTenant;
  }

  tools(ctx: TenantContext): readonly RunnableTool[] {
    return this.#byTenant.get(ctx.tenantId) ?? [];
  }
}
