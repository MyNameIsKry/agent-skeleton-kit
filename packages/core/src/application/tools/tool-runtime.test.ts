import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingLogger } from "../../../test/support/ingestion.js";
import type { RunnableTool, ToolSource } from "../../domain/ports.js";
import type { TenantConfig } from "../../domain/tenant.js";
import type { ArgsValidationResult, ToolContext, ToolHandler } from "../../domain/tool.js";
import { InMemoryTenantDataStoreFactory } from "../../testing.js";
import { InMemoryTenantRegistry } from "../tenants/in-memory-tenant-registry.js";
import { ToolRuntime } from "./tool-runtime.js";

const config = (id: string): TenantConfig => ({
  id,
  displayName: id,
  description: id,
  systemPrompt: id,
  retrieval: { topK: 5, minScore: 0.6 },
  chunking: { maxTokens: 400, overlap: 50 },
  tools: [],
  rootDir: `/srv/${id}`,
});
const registry = new InMemoryTenantRegistry([config("tenant-a"), config("tenant-b")]);
const tenantA = registry.resolve("tenant-a");
const tenantB = registry.resolve("tenant-b");

/** Accepts `{ id: string }` and nothing else. */
const validateId = (args: unknown): ArgsValidationResult => {
  const ok =
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).every((k) => k === "id") &&
    typeof (args as { id?: unknown }).id === "string";
  return ok ? { ok: true } : { ok: false, errors: [{ path: "/id", message: "must be string" }] };
};

const tool = (name: string, run: ToolHandler): RunnableTool => ({
  spec: { name, description: `Does ${name}`, parameters: { type: "object", additionalProperties: false } },
  validateArgs: validateId,
  run,
});

class MapSource implements ToolSource {
  constructor(private readonly byTenant: Record<string, RunnableTool[]>) {}
  tools(ctx: { tenantId: string }) {
    return this.byTenant[ctx.tenantId] ?? [];
  }
}

function setUp(tools: RunnableTool[], options: { timeoutMs?: number; maxResultChars?: number } = {}) {
  const logger = recordingLogger();
  const dataStores = new InMemoryTenantDataStoreFactory();
  const runtime = new ToolRuntime(
    { sources: [new MapSource({ "tenant-a": tools })], dataStores, logger },
    options,
  );
  const call = (name: string, args: unknown, signal = new AbortController().signal) =>
    runtime.execute(tenantA, { sessionId: "s-1", name, arguments: args, signal });
  return { runtime, logger, dataStores, call };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolRuntime", () => {
  it("lists the tenant's tools as name, description, and parameters only", () => {
    const { runtime } = setUp([tool("lookup", () => Promise.resolve({}))]);
    expect(runtime.listTools(tenantA)).toEqual([
      {
        name: "lookup",
        description: "Does lookup",
        parameters: { type: "object", additionalProperties: false },
      },
    ]);
    expect(runtime.listTools(tenantB)).toEqual([]);
  });

  it("runs a valid call with a cloned argument object and a context from the request", async () => {
    let seen: { args: unknown; ctx: ToolContext } | undefined;
    const args = { id: "A-1" };
    const { call } = setUp([
      // Returns a Date on purpose, to check that results are normalized to JSON.
      tool("lookup", ((a: Record<string, unknown>, ctx: ToolContext) => {
        a.id = "mutated";
        seen = { args: a, ctx };
        return Promise.resolve({ found: true, when: new Date("2026-01-02T03:04:05Z") });
      }) as unknown as ToolHandler),
    ]);

    const result = await call("lookup", args);

    expect(result).toMatchObject({ ok: true, result: { found: true, when: "2026-01-02T03:04:05.000Z" } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(args).toEqual({ id: "A-1" });
    expect(seen?.ctx).toMatchObject({ tenantId: "tenant-a", sessionId: "s-1" });
    expect(Object.isFrozen(seen?.ctx)).toBe(true);
  });

  it("rejects invalid arguments without calling the handler and returns the schema errors", async () => {
    const run = vi.fn<ToolHandler>(() => Promise.resolve({}));
    const { call } = setUp([tool("lookup", run)]);

    const result = await call("lookup", { id: 42 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: "The arguments do not match the tool's parameters: /id must be string.",
        details: [{ path: "/id", message: "must be string" }],
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects arguments the model sent as malformed JSON", async () => {
    const run = vi.fn<ToolHandler>(() => Promise.resolve({}));
    const { call } = setUp([tool("lookup", run)]);
    const result = await call("lookup", '{"id": "A-1"');
    expect(result).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a handler that throws into handler_error without its internal message", async () => {
    const { call, logger } = setUp([
      tool("lookup", () => Promise.reject(new Error("connection to db-internal:5432 refused"))),
    ]);

    const result = await call("lookup", { id: "A-1" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "handler_error",
        message: "The tool failed unexpectedly. Tell the user it could not be completed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("db-internal");
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ error: "connection to db-internal:5432 refused" }) as unknown,
      }),
    );
  });

  it("handles a handler that throws synchronously", async () => {
    const { call } = setUp([
      tool("lookup", () => {
        throw new Error("sync failure");
      }),
    ]);
    expect(await call("lookup", { id: "A-1" })).toMatchObject({
      ok: false,
      error: { code: "handler_error" },
    });
  });

  it("times out a slow handler, aborts its signal, and keeps going", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { call } = setUp(
      [
        tool("slow", (_args, ctx) => {
          signal = ctx.signal;
          return new Promise(() => undefined);
        }),
      ],
      { timeoutMs: 1_000 },
    );

    const pending = call("slow", { id: "A-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(result.ok ? "" : result.error.message).toContain("1000 ms");
    expect(signal?.aborted).toBe(true);
  });

  it("throws the abort reason when the caller cancels, instead of returning a tool error", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const { call } = setUp([tool("slow", () => new Promise(() => undefined))], { timeoutMs: 60_000 });

    const pending = call("slow", { id: "A-1" }, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("does not run anything when the caller already cancelled", async () => {
    const run = vi.fn<ToolHandler>(() => Promise.resolve({}));
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const { call } = setUp([tool("lookup", run)]);
    await expect(call("lookup", { id: "A-1" }, controller.signal)).rejects.toThrow("gone");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["no value", () => Promise.resolve(undefined), "The tool returned no usable result."],
    [
      "a value JSON cannot represent",
      () => Promise.resolve({ big: 10n }),
      "The tool returned no usable result.",
    ],
    [
      "a result that is too large",
      () => Promise.resolve({ text: "x".repeat(100) }),
      "The tool returned a result that is too large to use.",
    ],
  ])("rejects a handler that returns %s", async (_label, run, message) => {
    const { call } = setUp([tool("lookup", run as ToolHandler)], { maxResultChars: 50 });
    expect(await call("lookup", { id: "A-1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_result", message },
    });
  });

  it("lists available tools in an unknown_tool error, and says when there are none", async () => {
    const { call } = setUp([
      tool("lookup", () => Promise.resolve({})),
      tool("create", () => Promise.resolve({})),
    ]);
    expect(await call("delete_all", {})).toMatchObject({
      ok: false,
      error: {
        code: "unknown_tool",
        message: 'Tool "delete_all" is not available. Available tools: lookup, create.',
      },
    });
    const none = new ToolRuntime({
      sources: [],
      dataStores: new InMemoryTenantDataStoreFactory(),
      logger: recordingLogger(),
    });
    expect(
      await none.execute(tenantA, {
        sessionId: "s",
        name: "x",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { message: 'Tool "x" is not available. No tools are available.' } });
  });

  it("keeps the first tool when two sources declare the same name, and warns", async () => {
    const logger = recordingLogger();
    const runtime = new ToolRuntime({
      sources: [
        new MapSource({ "tenant-a": [tool("lookup", () => Promise.resolve({ from: "first" }))] }),
        new MapSource({ "tenant-a": [tool("lookup", () => Promise.resolve({ from: "second" }))] }),
      ],
      dataStores: new InMemoryTenantDataStoreFactory(),
      logger,
    });
    const result = await runtime.execute(tenantA, {
      sessionId: "s",
      name: "lookup",
      arguments: { id: "A-1" },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: true, result: { from: "first" } });
    expect(logger.entries.map((e) => e.message)).toContain(
      "Ignoring a tool whose name is already provided by another source",
    );
  });

  it("logs argument keys but never argument values", async () => {
    const { call, logger } = setUp([tool("lookup", () => Promise.resolve({}))]);
    await call("lookup", { id: 42, email: "ana@example.com" });
    expect(JSON.stringify(logger.entries)).not.toContain("ana@example.com");
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ fields: expect.objectContaining({ keys: ["email", "id"] }) as unknown }),
    );
  });
});
