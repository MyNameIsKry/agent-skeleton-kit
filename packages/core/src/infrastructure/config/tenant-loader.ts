/**
 * Loads tenant directories from disk: parse, validate, compile tool schemas, import handlers.
 * See design.md section 4.
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { parse as parseYaml } from "yaml";
import { ConfigurationError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { Logger } from "../../domain/ports.js";
import type { TenantConfig, ToolDefinition } from "../../domain/tenant.js";
import type { ToolHandler } from "../../domain/tool.js";
import { HandlerLoadError, loadHandler, type LoadedHandler } from "./handler-loader.js";
import { formatIssuePath, tenantFileSchema } from "./tenant-schema.js";

export const TENANT_CONFIG_FILES = ["tenant.yaml", "tenant.yml", "tenant.json"] as const;

export type ArgsValidationResult = { ok: true } | { ok: false; errors: { path: string; message: string }[] };

export interface LoadedTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly validateArgs: (args: unknown) => ArgsValidationResult;
}

/** Loader output. Handlers and validators stay here, never inside TenantConfig. */
export interface LoadedTenant {
  readonly config: TenantConfig;
  readonly tools: ReadonlyMap<string, LoadedTool>;
}

export interface TenantIssue {
  tenantDir: string;
  path: string;
  reason: string;
}

export class TenantConfigError extends ConfigurationError {
  readonly tenantIssues: readonly TenantIssue[];

  constructor(issues: readonly TenantIssue[]) {
    super(
      "Invalid tenant configuration:",
      issues.map((i) => `${i.tenantDir}: ${i.path}: ${i.reason}`),
      "Fix the files above. Run `npm run validate-tenant -- <tenant dir>` to check a single tenant.",
    );
    this.tenantIssues = Object.freeze([...issues]);
  }
}

export interface LoadTenantsOptions {
  logger?: Logger;
}

const displayPath = (dir: string): string => path.relative(process.cwd(), dir) || ".";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function formatAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): { path: string; message: string }[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "is invalid" }));
}

async function findConfigFiles(dir: string): Promise<string[]> {
  const entries = new Set(await readdir(dir));
  return TENANT_CONFIG_FILES.filter((name) => entries.has(name));
}

function parseConfigFile(fileName: string, content: string): unknown {
  return fileName.endsWith(".json") ? JSON.parse(content) : parseYaml(content, { prettyErrors: true });
}

/** Loads one tenant directory. Collects every problem, then throws a single TenantConfigError. */
async function loadTenantDirectoryCollecting(
  dir: string,
): Promise<{ tenant?: LoadedTenant; issues: TenantIssue[] }> {
  const tenantDir = displayPath(dir);
  const issues: TenantIssue[] = [];
  const issue = (issuePath: string, reason: string) => issues.push({ tenantDir, path: issuePath, reason });

  let rootDir: string;
  try {
    rootDir = await realpath(dir);
  } catch {
    issue("(directory)", "does not exist or is not readable");
    return { issues };
  }

  const configFiles = await findConfigFiles(rootDir);
  if (configFiles.length !== 1) {
    issue(
      "(directory)",
      configFiles.length === 0
        ? `missing ${TENANT_CONFIG_FILES.join(" or ")}`
        : `has more than one config file (${configFiles.join(", ")}); keep exactly one`,
    );
    return { issues };
  }
  const [configFile] = configFiles as [string];

  let raw: unknown;
  try {
    raw = parseConfigFile(configFile, await readFile(path.join(rootDir, configFile), "utf8"));
  } catch (error) {
    issue(configFile, `cannot be parsed: ${messageOf(error).split("\n")[0] ?? ""}`);
    return { issues };
  }

  const parsed = tenantFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) issue(formatIssuePath(zodIssue.path), zodIssue.message);
    return { issues };
  }
  const file = parsed.data;

  const dirName = path.basename(dir);
  if (file.id !== dirName) issue("id", `must equal the directory name "${dirName}"`);

  // One Ajv instance per tenant, so schema $ids cannot collide across tenants.
  const ajv = new Ajv({ strict: true, allErrors: true });
  const definitions: ToolDefinition[] = [];
  const runtime: { handler: ToolHandler; validate: ReturnType<Ajv["compile"]> }[] = [];

  for (const [index, tool] of file.tools.entries()) {
    const at = (field: string) => `tools[${index}].${field}`;

    if (definitions.some((d) => d.name === tool.name)) {
      issue(at("name"), `duplicate tool name "${tool.name}"`);
      continue;
    }

    let validate: ReturnType<Ajv["compile"]> | undefined;
    if (tool.parameters.type !== "object") {
      issue(at("parameters"), 'must have "type": "object"');
    } else {
      try {
        validate = ajv.compile(tool.parameters);
      } catch (error) {
        issue(at("parameters"), `is not a valid JSON Schema: ${messageOf(error)}`);
      }
    }

    let loaded: LoadedHandler | undefined;
    try {
      loaded = await loadHandler(rootDir, tool.handler);
    } catch (error) {
      if (!(error instanceof HandlerLoadError)) throw error;
      issue(at("handler"), `"${tool.handler}" ${error.message}`);
    }

    definitions.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handlerPath: loaded?.path ?? "",
    });
    if (validate !== undefined && loaded !== undefined) runtime.push({ handler: loaded.handler, validate });
  }

  if (issues.length > 0) return { issues };

  const config = deepFreeze({
    id: file.id,
    displayName: file.displayName,
    description: file.description,
    systemPrompt: file.systemPrompt,
    retrieval: file.retrieval,
    chunking: file.chunking,
    tools: definitions,
    rootDir,
  });

  // No issues means every tool produced exactly one runtime entry, in declaration order.
  const tools = new Map<string, LoadedTool>();
  config.tools.forEach((definition, i) => {
    const entry = runtime[i];
    if (entry === undefined) throw new Error(`Internal error: no runtime entry for tool ${definition.name}`);
    const { handler, validate } = entry;
    const validateArgs = (args: unknown): ArgsValidationResult =>
      validate(args) ? { ok: true } : { ok: false, errors: formatAjvErrors(validate.errors) };
    tools.set(definition.name, Object.freeze({ definition, handler, validateArgs }));
  });

  return { tenant: Object.freeze({ config, tools }), issues };
}

/** Loads a single tenant directory, for example for `validate-tenant`. */
export async function loadTenantDirectory(dir: string): Promise<LoadedTenant> {
  const { tenant, issues } = await loadTenantDirectoryCollecting(dir);
  if (tenant === undefined) throw new TenantConfigError(issues);
  return tenant;
}

/**
 * Loads every tenant under `tenantsDir`. Subdirectories without a config file are skipped
 * with a warning. Any invalid tenant fails the whole load, listing all problems at once.
 */
export async function loadTenants(
  tenantsDir: string,
  options: LoadTenantsOptions = {},
): Promise<LoadedTenant[]> {
  let entries;
  try {
    entries = await readdir(tenantsDir, { withFileTypes: true });
  } catch {
    throw new TenantConfigError([
      {
        tenantDir: displayPath(tenantsDir),
        path: "(directory)",
        reason: "TENANTS_DIR does not exist or is not readable",
      },
    ]);
  }

  const tenants: LoadedTenant[] = [];
  const issues: TenantIssue[] = [];

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  for (const name of dirs) {
    const dir = path.join(tenantsDir, name);
    if ((await findConfigFiles(dir)).length === 0) {
      options.logger?.warn({ dir: displayPath(dir) }, "Skipping directory without a tenant config file");
      continue;
    }
    const result = await loadTenantDirectoryCollecting(dir);
    issues.push(...result.issues);
    if (result.tenant !== undefined) tenants.push(result.tenant);
  }

  if (issues.length > 0) throw new TenantConfigError(issues);
  return tenants;
}
