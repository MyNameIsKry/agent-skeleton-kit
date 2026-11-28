/**
 * Isolation property P2 (design.md section 8): a tool executes only if its name is in the
 * requesting tenant's config. Also checks that a handler's context comes from the request,
 * never from model output, and that its data store is tenant-scoped (tenant-isolation rules
 * 4 to 6). Uses real tenant directories loaded by the tenant loader.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTenantRegistry } from "../../src/application/tenants/in-memory-tenant-registry.js";
import { ToolRuntime } from "../../src/application/tools/tool-runtime.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import { loadTenants } from "../../src/infrastructure/config/tenant-loader.js";
import { ConfigFileToolSource } from "../../src/infrastructure/tools/config-file-tool-source.js";
import { InMemoryTenantDataStoreFactory } from "../../src/testing.js";
import { recordingLogger } from "../support/ingestion.js";
import { TempDirs, writeTenant } from "../support/temp-tenant.js";

interface HandlerCall {
  tenant: string;
  ctxTenantId: string;
  ctxSessionId: string;
  args: unknown;
}

declare global {
  var __toolCalls: HandlerCall[] | undefined;
}

/** A handler that records its call, then stores and lists a record through ctx.data. */
const recordingHandler = (tenant: string) => `
export default async function handler(args, ctx) {
  globalThis.__toolCalls.push({ tenant: ${JSON.stringify(tenant)}, ctxTenantId: ctx.tenantId, ctxSessionId: ctx.sessionId, args });
  await ctx.data.insert("notes", { from: ${JSON.stringify(tenant)} });
  return { notes: (await ctx.data.find("notes")).map((n) => n.from) };
}
`;

// The schema declares `tenantId` and `sessionId` on purpose: valid arguments with those names
// must still not change the handler's context.
const SCHEMA =
  "{ type: object, additionalProperties: false, properties: { tenantId: { type: string }, sessionId: { type: string } } }";

const temps = new TempDirs();
let runtime: ToolRuntime;
let alpha: TenantContext;
let beta: TenantContext;
const logger = recordingLogger();

beforeAll(async () => {
  const root = await temps.make("tenants-");
  for (const [id, tool] of [
    ["tenant-alpha", "alpha_tool"],
    ["tenant-beta", "beta_tool"],
  ] as const) {
    const dir = await writeTenant(root, id, [{ name: tool, handler: `./tools/${tool}`, parameters: SCHEMA }]);
    await writeFile(path.join(dir, "tools", `${tool}.js`), recordingHandler(id));
  }
  const loaded = await loadTenants(root);
  const registry = new InMemoryTenantRegistry(loaded.map((t) => t.config));
  alpha = registry.resolve("tenant-alpha");
  beta = registry.resolve("tenant-beta");
  runtime = new ToolRuntime({
    sources: [new ConfigFileToolSource(loaded)],
    dataStores: new InMemoryTenantDataStoreFactory(),
    logger,
  });
});

beforeEach(() => {
  globalThis.__toolCalls = [];
  logger.entries.length = 0;
});

afterAll(async () => {
  globalThis.__toolCalls = undefined;
  await temps.cleanup();
});

const call = (ctx: TenantContext, name: string, args: unknown = {}) =>
  runtime.execute(ctx, {
    sessionId: "session-1",
    name,
    arguments: args,
    signal: new AbortController().signal,
  });

describe("tool allowlist (P2)", () => {
  it("offers each tenant only its own tools", () => {
    expect(runtime.listTools(alpha).map((t) => t.name)).toEqual(["alpha_tool"]);
    expect(runtime.listTools(beta).map((t) => t.name)).toEqual(["beta_tool"]);
  });

  it("rejects a call to another tenant's tool and runs no handler", async () => {
    const result = await call(alpha, "beta_tool");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unknown_tool",
        message: 'Tool "beta_tool" is not available. Available tools: alpha_tool.',
      },
    });
    expect(globalThis.__toolCalls).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Rejected a call to a tool that is not in the tenant's allowlist",
        fields: expect.objectContaining({ tenantId: "tenant-alpha", tool: "beta_tool" }) as unknown,
      }),
    );
  });

  it.each(["Beta_Tool", " alpha_tool", "alpha_tool ", "__proto__", "constructor", "toString", ""])(
    "rejects the name %j and runs no handler",
    async (name) => {
      expect(await call(alpha, name)).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
      expect(globalThis.__toolCalls).toEqual([]);
    },
  );

  it("runs the tenant's own tool with a context from the request, not from the arguments", async () => {
    const result = await call(alpha, "alpha_tool", {});
    const forged = await call(alpha, "alpha_tool", { tenantId: "tenant-beta", sessionId: "someone-else" });

    expect(result).toMatchObject({ ok: true });
    for (const recorded of globalThis.__toolCalls ?? []) {
      expect(recorded).toMatchObject({
        tenant: "tenant-alpha",
        ctxTenantId: "tenant-alpha",
        ctxSessionId: "session-1",
      });
    }
    expect(forged).toMatchObject({ ok: true });
    expect(globalThis.__toolCalls?.[1]?.args).toEqual({ tenantId: "tenant-beta", sessionId: "someone-else" });
  });

  it("gives each tenant's handler a data store that sees only that tenant's records", async () => {
    await call(alpha, "alpha_tool");
    const betaResult = await call(beta, "beta_tool");

    expect(betaResult).toMatchObject({ ok: true, result: { notes: ["tenant-beta"] } });
  });
});
