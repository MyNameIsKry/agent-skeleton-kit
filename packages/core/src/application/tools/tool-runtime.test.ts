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

  it("validates and passes the same copy, so a getter cannot change arguments after the check", async () => {
    let reads = 0;
    const tricky = {
      get id(): unknown {
        reads += 1;
        return reads === 1 ? "A-1" : { $evil: 1 };
      },
    };
    let seen: unknown;
    const { call } = setUp([
      tool("lookup", (args) => {
        seen = args;
        return Promise.resolve({});
      }),
    ]);

    expect(await call("lookup", tricky)).toMatchObject({ ok: true });
    expect(seen).toEqual({ id: "A-1" });
    expect(reads).toBe(1);
  });

  it.each([
    ["an array", [{ id: "A-1" }]],
    ["null", null],
    ["a Map", new Map([["id", "A-1"]])],
    ["an object holding a function", { id: "A-1", run: () => undefined }],
  ])("rejects arguments that are %s without calling the handler", async (_label, args) => {
    const run = vi.fn<ToolHandler>(() => Promise.resolve({}));
    const { call } = setUp([tool("lookup", run)]);
    expect(await call("lookup", args)).toMatchObject({
      ok: false,
      error: { code: "validation_failed", details: [{ path: "/", message: "must be a JSON object" }] },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("gives the handler a data store with only the four operations, frozen", async () => {
    let data: ToolContext["data"] | undefined;
    const { call } = setUp([
      tool("lookup", (_args, ctx) => {
        data = ctx.data;
        return Promise.resolve({});
      }),
    ]);
    await call("lookup", { id: "A-1" });
    expect(Object.keys(data ?? {}).sort()).toEqual(["find", "findOne", "insert", "update"]);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Reflect.set(data ?? {}, "tenantId", "tenant-b")).toBe(false);
  });

  it("refuses data store writes from a handler that keeps going after its timeout", async () => {
    vi.useFakeTimers();
    let later: Promise<{ id: string }> | undefined;
    const { call, dataStores } = setUp(
      [
        tool("slow", (_args, ctx) => {
          // Ignores its signal and writes once the call is already reported as timed out.
          const write = new Promise((resolve) => setTimeout(resolve, 2_000)).then(() =>
            ctx.data.insert("tickets", { title: "duplicate" }),
          );
          write.catch(() => undefined);
          later = write;
          return write;
        }),
      ],
      { timeoutMs: 1_000 },
    );

    const pending = call("slow", { id: "A-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ ok: false, error: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(later).rejects.toThrow("timed out");
    expect(dataStores.records).toEqual([]);
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

  it("logs a long handler error truncated, with the error name, and survives unprintable throws", async () => {
    const { call, logger } = setUp([
      tool("lookup", () => Promise.reject(new TypeError("x".repeat(1_000)))),
      // A thrown value String() cannot print: handlers are tenant code and may throw anything.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      tool("weird", () => Promise.reject(Object.create(null) as unknown)),
    ]);
    await call("lookup", { id: "A-1" });
    const entry = logger.entries.find((e) => e.message === "Tool handler threw");
    expect(entry?.fields).toMatchObject({ errorName: "TypeError" });
    expect(String(entry?.fields.error).length).toBeLessThan(250);

    expect(await call("weird", { id: "A-1" })).toMatchObject({ ok: false, error: { code: "handler_error" } });
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
      "a cyclic value",
      () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return Promise.resolve(cyclic);
      },
      "The tool returned no usable result.",
    ],
    [
      "a value whose toJSON throws",
      () =>
        Promise.resolve({
          toJSON: () => {
            throw new Error("no");
          },
        }),
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

  it("shows at most 64 characters of an unknown tool name in logs and in the error", async () => {
    const { call, logger } = setUp([tool("lookup", () => Promise.resolve({}))]);
    const name = `x${"y".repeat(5_000)}`;
    const result = await call(name, {});
    expect(result.ok ? "" : result.error.message.length).toBeLessThan(150);
    expect(JSON.stringify(logger.entries).length).toBeLessThan(1_000);
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
    runtime.listTools(tenantA);
    runtime.listTools(tenantA);
    // Warned once per tenant and name, not on every call.
    expect(
      logger.entries.filter(
        (e) => e.message === "Ignoring a tool whose name is already provided by another source",
      ),
    ).toHaveLength(1);
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
