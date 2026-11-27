/**
 * Minimal JSON client for OpenAI-compatible APIs, shared by the chat and embedding adapters.
 * Uses Node's built-in fetch (no vendor SDK), so any server that speaks the OpenAI wire
 * format works. See design.md section 3a.
 *
 * Responsibilities: auth header, per-call timeout combined with the caller's signal,
 * retries with backoff for 429, 5xx, and network errors, and error messages that never
 * contain the API key or the request body.
 */
import { ProviderError } from "../../domain/errors.js";
import type { Logger } from "../../domain/ports.js";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_DETAIL_LENGTH = 200;

/**
 * Configured keys shorter than this are placeholders such as `ollama` or `none`, not secrets.
 * Redacting them would mangle ordinary words in provider messages.
 */
const MIN_REDACTED_KEY_LENGTH = 8;

/** Key-shaped strings that providers sometimes echo, masked or not: sk-..., gsk_..., Bearer .... */
const KEY_SHAPED = /\b(?:sk|pk|rk|gsk|xai|key)[-_][A-Za-z0-9_*.-]{4,}/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=*-]+/gi;

export interface OpenAiCompatibleClientOptions {
  /** Used in error messages and logs, for example "LLM" or "Embedding". */
  label: string;
  baseUrl: string;
  /** Undefined: no Authorization header is sent. */
  apiKey: string | undefined;
  timeoutMs: number;
  retry?: RetryPolicy;
  fetch?: FetchFn;
  sleep?: SleepFn;
  logger?: Logger;
  /** Used for jitter. Injected so tests are deterministic. */
  random?: () => number;
  /** Current time in ms. Injected so tests are deterministic. */
  now?: () => number;
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** Sleeps for `ms`, or rejects with the signal's reason as soon as it aborts. */
export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** `Retry-After` in seconds or as an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class OpenAiCompatibleClient {
  readonly #options: Required<Omit<OpenAiCompatibleClientOptions, "apiKey" | "logger">> &
    Pick<OpenAiCompatibleClientOptions, "apiKey" | "logger">;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.#options = {
      retry: DEFAULT_RETRY,
      fetch: (input, init) => fetch(input, init),
      sleep: abortableSleep,
      random: Math.random,
      now: () => Date.now(),
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
    };
  }

  /**
   * POSTs `body` to `path` and returns the parsed JSON response.
   * Throws ProviderError for HTTP, network, timeout, and JSON errors. A caller abort is
   * re-thrown as the signal's reason, unwrapped.
   */
  async postJson(path: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    const { label, retry, logger, now } = this.#options;
    const url = `${this.#options.baseUrl}${path}`;
    const deadline = now() + this.#options.timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new TimeoutError(`${label} request timed out after ${this.#options.timeoutMs} ms`));
    }, this.#options.timeoutMs);
    const signal =
      callerSignal === undefined ? timeout.signal : AbortSignal.any([callerSignal, timeout.signal]);

    let lastError: ProviderError | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        const outcome = await this.#attempt(url, body, signal);
        if (outcome.kind === "ok") return outcome.value;
        lastError = outcome.error;

        if (!outcome.retryable || attempt >= retry.maxRetries) throw outcome.error;
        const delay = this.#delay(attempt, outcome.retryAfterMs);
        // Sleeping into the deadline would end in a timeout that hides the real cause.
        if (delay >= deadline - now()) throw outcome.error;
        logger?.warn(
          { provider: label, attempt: attempt + 1, delayMs: delay, reason: outcome.error.message },
          "Retrying provider request",
        );
        await this.#options.sleep(delay, signal);
      }
    } catch (error) {
      throw this.#mapAbort(error, callerSignal, timeout.signal, lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  async #attempt(
    url: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<
    | { kind: "ok"; value: unknown }
    | { kind: "error"; error: ProviderError; retryable: boolean; retryAfterMs?: number }
  > {
    const { label, apiKey } = this.#options;
    // Do not rely on fetch to notice an abort: a caller that already gave up gets no request.
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        kind: "error",
        error: new ProviderError(`${label} request failed: network error`, { cause: error }),
        retryable: true,
      };
    }

    if (!response.ok) {
      const detail = await this.#errorDetail(response);
      const hint = response.status === 401 ? " Check the API key." : "";
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return {
        kind: "error",
        error: new ProviderError(`${label} request failed with HTTP ${response.status}${detail}.${hint}`, {
          retryable: RETRYABLE_STATUS.has(response.status),
        }),
        retryable: RETRYABLE_STATUS.has(response.status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }

    try {
      const value: unknown = await response.json();
      return { kind: "ok", value };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        kind: "error",
        error: new ProviderError(`${label} returned a response that is not valid JSON`, {
          cause: error,
          retryable: false,
        }),
        retryable: false,
      };
    }
  }

  /** Provider error code and a short, redacted message. Never the request body. */
  async #errorDetail(response: Response): Promise<string> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return "";
    }
    let code: unknown;
    let message: unknown;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; type?: unknown; message?: unknown } };
      code = parsed.error?.code ?? parsed.error?.type;
      message = parsed.error?.message;
    } catch {
      message = text;
    }
    const parts: string[] = [];
    if (typeof code === "string" && code !== "") parts.push(code);
    if (typeof message === "string" && message.trim() !== "") parts.push(this.#redact(message.trim()));
    return parts.length === 0 ? "" : ` (${parts.join(": ")})`;
  }

  #redact(text: string): string {
    const { apiKey } = this.#options;
    let safe = text;
    if (apiKey !== undefined && apiKey.length >= MIN_REDACTED_KEY_LENGTH) {
      safe = safe.split(apiKey).join("[redacted]");
    }
    safe = safe.replace(KEY_SHAPED, "[redacted]").replace(BEARER_TOKEN, "Bearer [redacted]");
    return safe.length > MAX_DETAIL_LENGTH ? `${safe.slice(0, MAX_DETAIL_LENGTH)}...` : safe;
  }

  #delay(attempt: number, retryAfterMs: number | undefined): number {
    const { baseDelayMs, maxDelayMs } = this.#options.retry;
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxDelayMs);
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    // Equal jitter: a random delay between half and all of the exponential delay.
    return Math.round(exponential / 2 + (exponential / 2) * this.#options.random());
  }

  /**
   * Caller aborts propagate unchanged. Our own timeout becomes a ProviderError that names the
   * last failed attempt, if any, so a timeout after retries still shows why they were needed.
   */
  #mapAbort(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
    lastError: ProviderError | undefined,
  ): unknown {
    if (callerSignal?.aborted === true) return callerSignal.reason;
    if (timeoutSignal.aborted) {
      const reason = timeoutSignal.reason as unknown;
      const message = reason instanceof Error ? reason.message : `${this.#options.label} request timed out`;
      return new ProviderError(
        lastError === undefined ? message : `${message}. Last attempt: ${lastError.message}`,
        {
          cause: lastError ?? error,
        },
      );
    }
    return error;
  }
}
