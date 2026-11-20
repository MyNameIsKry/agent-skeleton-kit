/**
 * Loads tenant directories from disk: parse, validate, compile tool schemas, import handlers.
 * See design.md section 4.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { ConfigurationError } from "../../domain/errors.js";
import { deepFreeze } from "../../domain/freeze.js";
import type { Logger } from "../../domain/ports.js";
import type { ToolDefinition } from "../../domain/tenant.js";
import type {
  ArgsValidationIssue,
  ArgsValidationResult,
  LoadedTenant,
  LoadedTool,
  ToolHandler,
} from "../../domain/tool.js";
import { HandlerLoadError, loadHandler, type LoadedHandler } from "./handler-loader.js";
import { formatIssuePath, tenantFileSchema } from "./tenant-schema.js";

export type { LoadedTenant, LoadedTool } from "../../domain/tool.js";

export const TENANT_CONFIG_FILES = ["tenant.yaml", "tenant.yml", "tenant.json"] as const;

/** Tool parameter schemas use this dialect. Omitting `$schema` means the same. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

// ajv-formats is CommonJS with `exports.default`; under NodeNext its types expose the
// function as `.default` of the module, while at runtime the default import is the function.
type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats: AddFormats =
  typeof ajvFormats.default === "function"
    ? (ajvFormats.default as unknown as AddFormats)
    : (ajvFormats.default as unknown as { default: AddFormats }).default;

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

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "unknown error";

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): ArgsValidationIssue[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "is invalid" }));
}

function createAjv(): Ajv2020 {
  // One instance per tenant, so schema $ids cannot collide across tenants.
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
}

async function findConfigFiles(dir: string): Promise<string[]> {
  const entries = new Set(await readdir(dir));
  return TENANT_CONFIG_FILES.filter((name) => entries.has(name));
}

function parseConfigFile(fileName: string, content: string): unknown {
  return fileName.endsWith(".json") ? JSON.parse(content) : parseYaml(content, { prettyErrors: true });
}

/** Checks the root of a tool parameter schema before compiling it. Returns problems, if any. */
function checkParameterSchema(parameters: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  if (parameters.$schema !== undefined && parameters.$schema !== JSON_SCHEMA_DIALECT) {
    problems.push(`"$schema" must be "${JSON_SCHEMA_DIALECT}" or omitted (JSON Schema 2020-12)`);
  }
  if (parameters.type !== "object") {
    problems.push('must have "type": "object"');
  } else if (parameters.additionalProperties !== false) {
    // Isolation rule 5: the model must not be able to add arguments the tool did not declare.
    problems.push('must set "additionalProperties": false so the model cannot add undeclared arguments');
  }
  return problems;
}

/**
 * Loads one tenant directory and collects every problem instead of throwing.
 * @param dir Path of the tenant directory (or a symlink to it). Its last segment is the
 *   expected tenant id.
 */
async function loadTenantDirectoryCollecting(
  dir: string,
): Promise<{ tenant?: LoadedTenant; issues: TenantIssue[] }> {
  const tenantDir = displayPath(dir);
  const issues: TenantIssue[] = [];
  const issue = (issuePath: string, reason: string) => issues.push({ tenantDir, path: issuePath, reason });

  let rootDir: string;
  let configFiles: string[];
  try {
    rootDir = await realpath(dir);
    if (!(await stat(rootDir)).isDirectory()) {
      issue("(directory)", "is not a directory");
      return { issues };
    }
    configFiles = await findConfigFiles(rootDir);
  } catch (error) {
    issue("(directory)", `does not exist or is not readable (${errorCode(error)})`);
    return { issues };
  }

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

  // Schema errors stop here: the per-tool checks below need a well-formed file.
  const parsed = tenantFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) issue(formatIssuePath(zodIssue.path), zodIssue.message);
    return { issues };
  }
  const file = parsed.data;

  const dirName = path.basename(dir);
  if (file.id !== dirName) issue("id", `must equal the directory name "${dirName}"`);

  const ajv = createAjv();
  const definitions: ToolDefinition[] = [];
  const runtime: { handler: ToolHandler; validate: ValidateFunction }[] = [];

  for (const [index, tool] of file.tools.entries()) {
    const at = (field: string) => `tools[${index}].${field}`;

    if (definitions.some((d) => d.name === tool.name)) {
      issue(at("name"), `duplicate tool name "${tool.name}"`);
      continue;
    }

    let validate: ValidateFunction | undefined;
    const schemaProblems = checkParameterSchema(tool.parameters);
    for (const problem of schemaProblems) issue(at("parameters"), problem);
    if (schemaProblems.length === 0) {
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

/** A directory entry is a tenant candidate if it is a directory or a symlink to one. */
async function isDirectoryEntry(tenantsDir: string, entry: Dirent): Promise<boolean | "broken-link"> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(tenantsDir, entry.name))).isDirectory();
  } catch {
    return "broken-link";
  }
}

/**
 * Loads every tenant under `tenantsDir`, including tenants that are symlinked directories.
 * Subdirectories without a config file are skipped with a warning. Any invalid tenant fails
 * the whole load, listing all problems at once.
 */
export async function loadTenants(
  tenantsDir: string,
  options: LoadTenantsOptions = {},
): Promise<LoadedTenant[]> {
  let entries: Dirent[];
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

  const candidates = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of candidates) {
    const dir = path.join(tenantsDir, entry.name);
    const kind = await isDirectoryEntry(tenantsDir, entry);
    if (kind === false) continue;
    if (kind === "broken-link") {
      issues.push({ tenantDir: displayPath(dir), path: "(directory)", reason: "is a broken symlink" });
      continue;
    }

    let configFiles: string[];
    try {
      configFiles = await findConfigFiles(dir);
    } catch (error) {
      issues.push({
        tenantDir: displayPath(dir),
        path: "(directory)",
        reason: `is not readable (${errorCode(error)})`,
      });
      continue;
    }
    if (configFiles.length === 0) {
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
