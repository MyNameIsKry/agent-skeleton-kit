/**
 * Runs the tools a model asks for (design.md section 7a). Written once on top of any
 * ToolSource, so allowlist, validation, timeout, and error shaping apply to every source.
 *
 * Order of checks for every call (tenant-isolation rules 4 to 6):
 *   1. The name must be one of the requesting tenant's tools. Nothing else is looked up first.
 *   2. The arguments are cloned into a plain object, and that copy must match the tool's JSON
 *      Schema. The handler gets the same copy, so nothing can change between check and use.
 *   3. The handler runs with a context built here: tenant and session from the request, a
 *      tenant-scoped data store that refuses work once the call is over, a child logger, and a
 *      signal that aborts on timeout.
 *   4. The result must be JSON of bounded size.
 * Tool faults become error results the model can act on. Only a caller abort is thrown.
 */
import type { JsonValue } from "../../domain/json.js";
import type {
  Clock,
  LlmToolSpec,
  Logger,
  RunnableTool,
  TenantDataStoreFactory,
  ToolError,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
  ToolSource,
} from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import type { TenantDataStore, TenantRecord, ToolContext } from "../../domain/tool.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
/** Results go back into the prompt, so they are kept small. */
export const MAX_TOOL_RESULT_CHARS = 16_000;

export interface ToolRuntimeDeps {
  sources: readonly ToolSource[];
  dataStores: TenantDataStoreFactory;
  logger: Logger;
  clock?: Clock;
}

export interface ToolRuntimeOptions {
  /** TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
  maxResultChars?: number;
}

class ToolTimeoutError extends Error {
  override readonly name = "ToolTimeoutError";
}

const systemClock: Clock = { now: () => new Date() };

/** Tool names from the model are untrusted; logs and messages show at most this many characters. */
const MAX_SHOWN_NAME_CHARS = 64;
/** Handler error messages are logged up to this length. */
const MAX_LOGGED_ERROR_CHARS = 200;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

const shownName = (name: unknown): string =>
  typeof name === "string" ? truncate(name, MAX_SHOWN_NAME_CHARS) : `<${typeof name}>`;

/** Top-level argument keys, for logs. Values may hold personal data and are never logged by the runtime. */
const argumentKeys = (args: unknown): string[] =>
  args !== null && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).sort() : [];

/** Name and truncated message of a thrown value, for logs. Never throws, whatever was thrown. */
function describeError(error: unknown): { errorName: string; error: string } {
  try {
    if (error instanceof Error) {
      return { errorName: error.name, error: truncate(error.message, MAX_LOGGED_ERROR_CHARS) };
    }
    return { errorName: typeof error, error: truncate(String(error), MAX_LOGGED_ERROR_CHARS) };
  } catch {
    return { errorName: typeof error, error: "<unprintable>" };
  }
}

/** A copy of the arguments as a plain object, or undefined if they cannot be one. */
function cloneArguments(args: unknown): Record<string, unknown> | undefined {
  let copy: unknown;
  try {
    copy = structuredClone(args);
  } catch {
    return undefined;
  }
  if (copy === null || typeof copy !== "object" || Object.getPrototypeOf(copy) !== Object.prototype) {
    return undefined;
  }
  return copy as Record<string, unknown>;
}

/**
 * The store a handler sees: only the four operations, each refused once the call has timed out
 * or was cancelled, so a handler that ignores its signal cannot write after the model was told
 * the call failed. An operation already in flight completes.
 */
function guardStore(store: TenantDataStore, signal: AbortSignal): TenantDataStore {
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    return operation();
  };
  return Object.freeze({
    insert: (collection: string, doc: TenantRecord) => guarded(() => store.insert(collection, doc)),
    findOne: (collection: string, filter: TenantRecord) => guarded(() => store.findOne(collection, filter)),
    find: (collection: string, filter?: TenantRecord, limit?: number) =>
      guarded(() => store.find(collection, filter, limit)),
    update: (collection: string, filter: TenantRecord, patch: TenantRecord) =>
      guarded(() => store.update(collection, filter, patch)),
  });
}

export class ToolRuntime implements ToolExecutor {
  readonly #deps: ToolRuntimeDeps;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #maxResultChars: number;
  /** `${tenantId}\u0000${name}` of duplicates already warned about, so each is logged once. */
  readonly #warnedDuplicates = new Set<string>();

  constructor(deps: ToolRuntimeDeps, options: ToolRuntimeOptions = {}) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxResultChars = options.maxResultChars ?? MAX_TOOL_RESULT_CHARS;
  }

  /** The tenant's tools by name. If two sources declare the same name, the first wins. */
  #toolsOf(ctx: TenantContext): Map<string, RunnableTool> {
    const tools = new Map<string, RunnableTool>();
    for (const source of this.#deps.sources) {
      for (const tool of source.tools(ctx)) {
        if (tools.has(tool.spec.name)) {
          const key = `${ctx.tenantId}\u0000${tool.spec.name}`;
          if (!this.#warnedDuplicates.has(key)) {
            this.#warnedDuplicates.add(key);
            this.#deps.logger.warn(
              { tenantId: ctx.tenantId, tool: tool.spec.name },
              "Ignoring a tool whose name is already provided by another source",
            );
          }
          continue;
        }
        tools.set(tool.spec.name, tool);
      }
    }
    return tools;
  }

  listTools(ctx: TenantContext): readonly LlmToolSpec[] {
    return [...this.#toolsOf(ctx).values()].map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    }));
  }

  async execute(ctx: TenantContext, invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const started = this.#clock.now().getTime();
    const elapsed = () => Math.max(0, this.#clock.now().getTime() - started);
    const fail = (error: ToolError): ToolExecutionResult => ({ ok: false, error, durationMs: elapsed() });
    const log = this.#deps.logger.child({
      tenantId: ctx.tenantId,
      sessionId: invocation.sessionId,
      tool: shownName(invocation.name),
    });

    invocation.signal.throwIfAborted();

    // 1. Allowlist. A Map lookup, so names like "__proto__" or "constructor" find nothing.
    const tools = this.#toolsOf(ctx);
    const tool = typeof invocation.name === "string" ? tools.get(invocation.name) : undefined;
    if (tool === undefined) {
      const available = [...tools.keys()];
      log.warn({ available }, "Rejected a call to a tool that is not in the tenant's allowlist");
      return fail({
        code: "unknown_tool",
        message:
          available.length === 0
            ? `Tool "${shownName(invocation.name)}" is not available. No tools are available.`
            : `Tool "${shownName(invocation.name)}" is not available. Available tools: ${available.join(", ")}.`,
      });
    }

    // 2. Arguments. A raw string means the model sent arguments that were not valid JSON.
    if (typeof invocation.arguments === "string") {
      log.info({}, "Rejected tool arguments that are not a JSON object");
      return fail({
        code: "validation_failed",
        message: "The arguments are not valid JSON. Send a JSON object that matches the tool's parameters.",
        details: [{ path: "/", message: "must be a JSON object" }],
      });
    }
    // Validate the copy the handler will get, never the caller's object (getters, later mutation).
    const args = cloneArguments(invocation.arguments);
    if (args === undefined) {
      log.info({}, "Rejected tool arguments that are not a plain JSON object");
      return fail({
        code: "validation_failed",
        message: "The arguments must be a JSON object that matches the tool's parameters.",
        details: [{ path: "/", message: "must be a JSON object" }],
      });
    }
    const validation = tool.validateArgs(args);
    if (!validation.ok) {
      log.info({ keys: argumentKeys(args), errors: validation.errors }, "Rejected invalid tool arguments");
      return fail({
        code: "validation_failed",
        message: `The arguments do not match the tool's parameters: ${validation.errors
          .map((e) => `${e.path} ${e.message}`)
          .join("; ")}.`,
        details: validation.errors,
      });
    }

    // 3. Run with a timeout and a context the arguments cannot influence.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new ToolTimeoutError(`Tool ${tool.spec.name} timed out after ${this.#timeoutMs} ms`));
    }, this.#timeoutMs);
    const signal = AbortSignal.any([invocation.signal, timeout.signal]);
    const toolContext: ToolContext = Object.freeze({
      tenantId: ctx.tenantId,
      sessionId: invocation.sessionId,
      logger: log,
      signal,
      data: guardStore(this.#deps.dataStores.forTenant(ctx), signal),
    });

    let raw: unknown;
    try {
      const running = Promise.resolve().then(() => tool.run(args, toolContext));
      // A handler that ignores its signal keeps running in the background; its outcome is ignored.
      running.catch(() => undefined);
      raw = await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
      ]);
    } catch (error) {
      if (invocation.signal.aborted) throw invocation.signal.reason;
      if (timeout.signal.aborted) {
        log.warn({ timeoutMs: this.#timeoutMs }, "Tool timed out");
        return fail({
          code: "timeout",
          message: `The tool did not finish within ${this.#timeoutMs} ms. Tell the user it is not responding right now.`,
        });
      }
      // The handler's message may contain internal details or argument values, so only the logs
      // see it, truncated.
      log.error(describeError(error), "Tool handler threw");
      return fail({
        code: "handler_error",
        message: "The tool failed unexpectedly. Tell the user it could not be completed.",
      });
    } finally {
      clearTimeout(timer);
    }

    // 4. Result: JSON of bounded size. JSON.stringify also normalizes (dates to strings, undefined fields dropped).
    let text: string | undefined;
    try {
      text = JSON.stringify(raw);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      log.error({}, "Tool returned a value that is not JSON");
      return fail({ code: "invalid_result", message: "The tool returned no usable result." });
    }
    if (text.length > this.#maxResultChars) {
      log.error({ chars: text.length, maxChars: this.#maxResultChars }, "Tool result is too large");
      return fail({
        code: "invalid_result",
        message: "The tool returned a result that is too large to use.",
      });
    }
    const result = JSON.parse(text) as JsonValue;
    log.info({ durationMs: elapsed() }, "Tool call succeeded");
    return { ok: true, result, durationMs: elapsed() };
  }
}
