/**
 * validate-tenant: checks tenant directories without starting servers or needing API keys.
 *
 *   npm run validate-tenant -- examples/ops-onboarding-copilot [more dirs...]
 *   npm run validate-tenant            # every tenant in TENANTS_DIR
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryTenantRegistry } from "./application/tenants/in-memory-tenant-registry.js";
import { ConfigurationError } from "./domain/errors.js";
import type { TenantSummary } from "./domain/tenant.js";
import { loadEnv, type EnvSource } from "./infrastructure/config/env.js";
import {
  loadTenantDirectory,
  loadTenants,
  type LoadedTenant,
} from "./infrastructure/config/tenant-loader.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: EnvSource;
}

const describe = (tenant: TenantSummary): string =>
  `ok  ${tenant.id} (${tenant.tools.length} tool${tenant.tools.length === 1 ? "" : "s"}: ${
    tenant.tools.map((t) => t.name).join(", ") || "none"
  })\n`;

/** Returns the process exit code. */
export async function main(args: readonly string[], io: CliIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(
      "Usage: validate-tenant [tenant-dir ...]\nWithout arguments, validates every tenant in TENANTS_DIR.\n",
    );
    return 0;
  }

  try {
    const tenants: LoadedTenant[] = [];
    if (args.length === 0) {
      const { tenants: env } = loadEnv(["tenants"], io.env);
      tenants.push(...(await loadTenants(path.resolve(env.tenantsDir))));
    } else {
      let failed = false;
      for (const dir of args) {
        try {
          tenants.push(await loadTenantDirectory(path.resolve(dir)));
        } catch (error) {
          if (!(error instanceof ConfigurationError)) throw error;
          io.stderr(`${error.message}\n`);
          failed = true;
        }
      }
      if (failed) return 1;
    }

    // Same cross-tenant checks the API applies at startup (unique ids).
    const registry = new InMemoryTenantRegistry(tenants.map((t) => t.config));
    for (const tenant of registry.list()) io.stdout(describe(tenant));
    io.stdout(`${tenants.length} tenant${tenants.length === 1 ? "" : "s"} valid.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
