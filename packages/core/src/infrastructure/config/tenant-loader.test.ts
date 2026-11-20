import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../test/support/fixture-paths.js";
import { OK_HANDLER, TempDirs, writeTenant } from "../../../test/support/temp-tenant.js";
import type { Logger } from "../../domain/ports.js";
import type { ToolContext } from "../../domain/tool.js";
import { loadTenantDirectory, loadTenants, TenantConfigError, type TenantIssue } from "./tenant-loader.js";

async function issuesOf(promise: Promise<unknown>): Promise<Omit<TenantIssue, "tenantDir">[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TenantConfigError)
      return error.tenantIssues.map(({ path, reason }) => ({ path, reason }));
    throw error;
  }
  throw new Error("expected a TenantConfigError");
}

const toolCtx = (tenantId: string): ToolContext => ({
  tenantId,
  sessionId: "s1",
  logger: {} as Logger,
  signal: new AbortController().signal,
  data: {} as ToolContext["data"],
});

const temps = new TempDirs();
afterEach(() => temps.cleanup());

describe("loadTenantDirectory with valid tenants", () => {
  it("loads a YAML tenant with a TypeScript handler and applies defaults", async () => {
    const { config, tools } = await loadTenantDirectory(FIXTURES.alpha);

    expect(config.id).toBe("fixture-alpha");
    expect(config.retrieval).toEqual({ topK: 3, minScore: 0.5 });
    expect(config.chunking).toEqual({ maxTokens: 400, overlap: 50 });
    expect(config.rootDir).toBe(FIXTURES.alpha);
    expect(config.tools.map((t) => t.name)).toEqual(["lookup_alpha"]);
    expect(config.tools[0]?.handlerPath).toBe(path.join(FIXTURES.alpha, "tools/lookup-alpha.ts"));

    const tool = tools.get("lookup_alpha")!;
    await expect(tool.handler({ id: "A-1" }, toolCtx("fixture-alpha"))).resolves.toEqual({
      ok: true,
      tenant: "fixture-alpha",
      id: "A-1",
    });
  });

  it("loads a JSON tenant with a JavaScript handler", async () => {
    const { config, tools } = await loadTenantDirectory(FIXTURES.beta);
    expect(config.id).toBe("fixture-beta");
    expect(config.retrieval).toEqual({ topK: 5, minScore: 0.6 });
    expect(config.tools[0]?.handlerPath).toBe(path.join(FIXTURES.beta, "tools/lookup-beta.js"));
    expect(tools.has("lookup_beta")).toBe(true);
  });

  it("deep-freezes the config and reuses the frozen definition in the loaded tool", async () => {
    const { config, tools } = await loadTenantDirectory(FIXTURES.alpha);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tools[0]?.parameters)).toBe(true);
    expect(tools.get("lookup_alpha")?.definition).toBe(config.tools[0]);
    expect(() => {
      (config as { systemPrompt: string }).systemPrompt = "changed";
    }).toThrow(TypeError);
  });

  it("compiles tool schemas into argument validators", async () => {
    const tool = (await loadTenantDirectory(FIXTURES.alpha)).tools.get("lookup_alpha")!;
    expect(tool.validateArgs({ id: "A-7" })).toEqual({ ok: true });
    expect(tool.validateArgs({ id: "B-7", extra: 1 })).toEqual({
      ok: false,
      errors: [
        { path: "/", message: "must NOT have additional properties" },
        { path: "/id", message: 'must match pattern "^A-[0-9]+$"' },
      ],
    });
  });

  it("accepts the JSON Schema 2020-12 dialect and validates formats", async () => {
    const root = await temps.make();
    const dir = await writeTenant(root, "with-formats", [
      {
        name: "notify",
        handler: "./tools/notify",
        parameters:
          '{ $schema: "https://json-schema.org/draft/2020-12/schema", type: object, additionalProperties: false, ' +
          "required: [email], properties: { email: { type: string, format: email } } }",
      },
    ]);
    await writeFile(path.join(dir, "tools", "notify.js"), OK_HANDLER);

    const tool = (await loadTenantDirectory(dir)).tools.get("notify")!;
    expect(tool.validateArgs({ email: "ana@example.com" })).toEqual({ ok: true });
    expect(tool.validateArgs({ email: "not an email" })).toEqual({
      ok: false,
      errors: [{ path: "/email", message: 'must match format "email"' }],
    });
  });
});

describe("loadTenantDirectory with invalid tenants", () => {
  it("reports every schema problem with its field path", async () => {
    expect(await issuesOf(loadTenantDirectory(FIXTURES.invalid("bad-fields")))).toEqual([
      { path: "displayName", reason: "is required" },
      { path: "description", reason: "must not be empty" },
      { path: "retrieval.topK", reason: "Too small: expected number to be >=1" },
      { path: "chunking.overlap", reason: "overlap must be smaller than maxTokens" },
      { path: "(root)", reason: 'Unrecognized key: "unknownKey"' },
    ]);
  });

  it("rejects an id that differs from the directory name", async () => {
    expect(await issuesOf(loadTenantDirectory(FIXTURES.invalid("id-mismatch")))).toEqual([
      { path: "id", reason: 'must equal the directory name "id-mismatch"' },
    ]);
  });

  it("rejects an id that breaks the id pattern", async () => {
    expect(await issuesOf(loadTenantDirectory(FIXTURES.invalid("Bad_Id")))).toEqual([
      { path: "id", reason: "must match ^[a-z0-9][a-z0-9-]{1,62}$" },
    ]);
  });

  it("rejects a directory with more than one config file", async () => {
    const issues = await issuesOf(loadTenantDirectory(FIXTURES.invalid("two-configs")));
    expect(issues).toEqual([
      { path: "(directory)", reason: expect.stringContaining("more than one config file") as string },
    ]);
  });

  it("rejects a directory without a config file", async () => {
    expect(await issuesOf(loadTenantDirectory(path.join(FIXTURES.validTenants, "not-a-tenant")))).toEqual([
      { path: "(directory)", reason: "missing tenant.yaml or tenant.yml or tenant.json" },
    ]);
  });

  it("reports a file passed as the tenant directory instead of crashing", async () => {
    expect(await issuesOf(loadTenantDirectory(path.join(FIXTURES.alpha, "tenant.yaml")))).toEqual([
      { path: "(directory)", reason: "is not a directory" },
    ]);
  });

  it("reports a missing tenant directory", async () => {
    expect(await issuesOf(loadTenantDirectory(path.join(FIXTURES.validTenants, "nope")))).toEqual([
      { path: "(directory)", reason: "does not exist or is not readable (ENOENT)" },
    ]);
  });

  it("reports a file that cannot be parsed", async () => {
    const [issue] = await issuesOf(loadTenantDirectory(FIXTURES.invalid("unparsable")));
    expect(issue?.path).toBe("tenant.yaml");
    expect(issue?.reason).toMatch(/^cannot be parsed: /);
  });

  it("rejects a missing handler file and lists the paths tried", async () => {
    expect(await issuesOf(loadTenantDirectory(FIXTURES.invalid("missing-handler")))).toEqual([
      {
        path: "tools[0].handler",
        reason:
          '"./tools/ghost" file not found (tried tools/ghost, tools/ghost.js, tools/ghost.mjs, tools/ghost.ts)',
      },
    ]);
  });

  it("rejects a handler whose default export is not a function", async () => {
    expect(await issuesOf(loadTenantDirectory(FIXTURES.invalid("handler-not-function")))).toEqual([
      { path: "tools[0].handler", reason: '"./tools/not-function" must default-export a function' },
    ]);
  });

  it("rejects non-object schemas, invalid schemas, duplicate names, and bad names", async () => {
    const issues = await issuesOf(loadTenantDirectory(FIXTURES.invalid("bad-tools")));
    expect(issues.map((i) => i.path)).toEqual(["tools[3].name"]);

    // Name problems are schema errors and stop loading early. Fix the name to see the rest.
    const root = await temps.make();
    const copy = path.join(root, "bad-tools");
    await cp(FIXTURES.invalid("bad-tools"), copy, { recursive: true });
    const yaml = await readFile(path.join(copy, "tenant.yaml"), "utf8");
    await writeFile(path.join(copy, "tenant.yaml"), yaml.replace("Bad-Name", "good_name"));

    const rest = await issuesOf(loadTenantDirectory(copy));
    expect(rest).toEqual([
      { path: "tools[0].parameters", reason: 'must have "type": "object"' },
      {
        path: "tools[1].parameters",
        reason: expect.stringContaining("is not a valid JSON Schema") as string,
      },
      { path: "tools[2].name", reason: 'duplicate tool name "invalid_schema"' },
    ]);
  });

  it("requires closed schemas, the 2020-12 dialect, and known formats", async () => {
    const issues = await issuesOf(loadTenantDirectory(FIXTURES.invalid("schema-rules")));
    expect(issues).toEqual([
      {
        path: "tools[0].parameters",
        reason: 'must set "additionalProperties": false so the model cannot add undeclared arguments',
      },
      {
        path: "tools[1].parameters",
        reason:
          '"$schema" must be "https://json-schema.org/draft/2020-12/schema" or omitted (JSON Schema 2020-12)',
      },
      {
        path: "tools[2].parameters",
        reason: expect.stringMatching(/^is not a valid JSON Schema: unknown format "not-a-format"/) as string,
      },
    ]);
  });

  it("reports file-system errors in handler paths as issues instead of crashing", async () => {
    const root = await temps.make();
    const dir = await writeTenant(root, "fs-errors", [
      { name: "through_file", handler: "./tools/ok.js/inner" },
      { name: "loop", handler: "./tools/loop" },
      { name: "nul_byte", handler: "./tools/a\u0000b" },
    ]);
    await writeFile(path.join(dir, "tools", "ok.js"), OK_HANDLER);
    await symlink(path.join(dir, "tools", "loop.js"), path.join(dir, "tools", "loop.js"));

    expect(await issuesOf(loadTenantDirectory(dir))).toEqual([
      {
        path: "tools[0].handler",
        reason: expect.stringMatching(/^"\.\/tools\/ok\.js\/inner" file not found/) as string,
      },
      { path: "tools[1].handler", reason: '"./tools/loop" is part of a symlink loop' },
      { path: "tools[2].handler", reason: '"./tools/a\u0000b" must not contain NUL characters' },
    ]);
  });
});

describe("loadTenants", () => {
  it("loads every tenant in a directory, sorted, and skips directories without config", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;

    const tenants = await loadTenants(FIXTURES.validTenants, { logger });

    expect(tenants.map((t) => t.config.id)).toEqual(["fixture-alpha", "fixture-beta"]);
    expect(warn).toHaveBeenCalledWith(
      { dir: expect.stringContaining("not-a-tenant") as string },
      "Skipping directory without a tenant config file",
    );
  });

  it("loads a tenant that is a symlinked directory", async () => {
    const root = await temps.make();
    await symlink(FIXTURES.alpha, path.join(root, "fixture-alpha"), "dir");

    const tenants = await loadTenants(root);

    expect(tenants.map((t) => t.config.id)).toEqual(["fixture-alpha"]);
    expect(tenants[0]?.config.rootDir).toBe(FIXTURES.alpha);
  });

  it("reports a broken symlink instead of skipping it silently", async () => {
    const root = await temps.make();
    await symlink(path.join(root, "missing-target"), path.join(root, "dangling"));

    expect(await issuesOf(loadTenants(root))).toEqual([
      { path: "(directory)", reason: "is a broken symlink" },
    ]);
  });

  it("ignores plain files next to tenant directories", async () => {
    const root = await temps.make();
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "README.md"), "Not a tenant.\n");
    expect(await loadTenants(root)).toEqual([]);
  });

  it("fails once with the problems of every invalid tenant", async () => {
    let error: unknown;
    try {
      await loadTenants(FIXTURES.invalidTenants);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TenantConfigError);
    const dirs = new Set((error as TenantConfigError).tenantIssues.map((i) => path.basename(i.tenantDir)));
    expect([...dirs].sort()).toEqual([
      "Bad_Id",
      "bad-fields",
      "bad-tools",
      "escape-absolute",
      "escape-dotdot",
      "handler-not-function",
      "id-mismatch",
      "missing-handler",
      "schema-rules",
      "two-configs",
      "unparsable",
    ]);
    expect((error as TenantConfigError).message).toMatch(/^Invalid tenant configuration:\n/);
  });

  it("fails clearly when the tenants directory does not exist", async () => {
    expect(await issuesOf(loadTenants(path.join(FIXTURES.validTenants, "does-not-exist")))).toEqual([
      { path: "(directory)", reason: "TENANTS_DIR does not exist or is not readable" },
    ]);
  });
});
