import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, hang, json, recordingSleep } from "../../../test/support/fake-fetch.js";
import { ProviderError } from "../../domain/errors.js";
import {
  abortableSleep,
  OpenAiCompatibleClient,
  parseRetryAfter,
  type OpenAiCompatibleClientOptions,
} from "./http-client.js";

const API_KEY = "sk-test-0123456789abcdef";

function client(
  fetch: OpenAiCompatibleClientOptions["fetch"],
  overrides: Partial<OpenAiCompatibleClientOptions> = {},
) {
  const sleep = recordingSleep();
  const c = new OpenAiCompatibleClient({
    label: "LLM",
    baseUrl: "https://api.example.com/v1/",
    apiKey: API_KEY,
    timeoutMs: 60_000,
    random: () => 1,
    sleep: sleep.sleep,
    ...(fetch === undefined ? {} : { fetch }),
    ...overrides,
  });
  return { client: c, delays: sleep.delays };
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe("OpenAiCompatibleClient", () => {
  it("posts JSON with a bearer token to the joined URL", async () => {
    const { fetch, requests } = fakeFetch(json({ ok: true }));
    await expect(client(fetch).client.postJson("/chat/completions", { a: 1 })).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      {
        url: "https://api.example.com/v1/chat/completions",
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: { a: 1 },
      },
    ]);
  });

  it("sends no Authorization header when no key is configured", async () => {
    const { fetch, requests } = fakeFetch(json({}));
    await client(fetch, { apiKey: undefined }).client.postJson("/embeddings", {});
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("retries 429 and 5xx, honoring Retry-After, then succeeds", async () => {
    const { fetch, requests } = fakeFetch(
      json({ error: { message: "slow down" } }, 429, { "retry-after": "2" }),
      json({}, 503),
      json({ done: true }),
    );
    const { client: c, delays } = client(fetch);
    await expect(c.postJson("/x", {})).resolves.toEqual({ done: true });
    expect(requests).toHaveLength(3);
    // 2 s from Retry-After, then exponential backoff (1000 ms with random() = 1) for the 503.
    expect(delays).toEqual([2_000, 1_000]);
  });

  it("caps the Retry-After delay", async () => {
    const { fetch } = fakeFetch(json({}, 429, { "retry-after": "600" }), json({}));
    const { client: c, delays } = client(fetch);
    await c.postJson("/x", {});
    expect(delays).toEqual([8_000]);
  });

  it("gives up after the retry limit with the last status", async () => {
    const { fetch, requests } = fakeFetch(json({}, 500), json({}, 502), json({}, 504));
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(requests).toHaveLength(3);
    expect(error.message).toBe("LLM request failed with HTTP 504.");
  });

  it("does not retry other 4xx and reports the provider code and message", async () => {
    const { fetch, requests } = fakeFetch(
      json({ error: { code: "model_not_found", message: "The model `gpt-x` does not exist" } }, 404),
    );
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(requests).toHaveLength(1);
    expect(error.message).toBe(
      "LLM request failed with HTTP 404 (model_not_found: The model `gpt-x` does not exist).",
    );
  });

  it("redacts the API key and key-shaped strings from provider messages", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          error: {
            code: "invalid_api_key",
            message: `Incorrect API key provided: ${API_KEY} or sk-abc...wxyz`,
          },
        },
        401,
      ),
    );
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain("sk-abc");
    expect(error.message).toContain("[redacted]");
    expect(error.message).toMatch(/Check the API key\.$/);
    expect(error.safeMessage).toBe("The AI provider is unavailable. Please try again.");
  });

  it("retries network errors", async () => {
    const { fetch, requests } = fakeFetch(new TypeError("fetch failed"), json({ ok: 1 }));
    await expect(client(fetch).client.postJson("/x", {})).resolves.toEqual({ ok: 1 });
    expect(requests).toHaveLength(2);
  });

  it("reports a body that is not JSON without retrying", async () => {
    const { fetch, requests } = fakeFetch(new Response("<html>gateway</html>", { status: 200 }));
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(error.message).toBe("LLM returned a response that is not valid JSON");
    expect(requests).toHaveLength(1);
  });

  it("turns its own timeout into a ProviderError", async () => {
    const { fetch } = fakeFetch(hang());
    const error = await providerError(client(fetch, { timeoutMs: 20 }).client.postJson("/x", {}));
    expect(error.message).toBe("LLM request timed out after 20 ms");
  });

  it("re-throws a caller abort unchanged instead of wrapping it", async () => {
    const { fetch } = fakeFetch(hang());
    const controller = new AbortController();
    const reason = new Error("client went away");
    const pending = client(fetch, { timeoutMs: 5_000 }).client.postJson("/x", {}, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("does not send a request when the caller already aborted", async () => {
    const { fetch, requests } = fakeFetch(json({}));
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(client(fetch).client.postJson("/x", {}, controller.signal)).rejects.toThrow("already gone");
    expect(requests).toHaveLength(0);
  });
});

describe("OpenAiCompatibleClient time budget", () => {
  it("fails fast with the HTTP error when the backoff would outlast the budget", async () => {
    const { fetch, requests } = fakeFetch(
      json({ error: { message: "rate limited" } }, 429, { "retry-after": "8" }),
    );
    const { client: c, delays } = client(fetch, { timeoutMs: 1_000 });
    const error = await providerError(c.postJson("/x", {}));
    expect(error.message).toBe("LLM request failed with HTTP 429 (rate limited).");
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("names the last failed attempt when the budget runs out on a later attempt", async () => {
    const { fetch } = fakeFetch(json({}, 503), hang());
    const { client: c } = client(fetch, {
      timeoutMs: 50,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const error = await providerError(c.postJson("/x", {}));
    expect(error.message).toBe(
      "LLM request timed out after 50 ms. Last attempt: LLM request failed with HTTP 503.",
    );
    expect(error.cause).toBeInstanceOf(ProviderError);
  });

  it("gives up after network errors exhaust the retries", async () => {
    const { fetch, requests } = fakeFetch(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(error.message).toBe("LLM request failed: network error");
    expect(requests).toHaveLength(3);
  });

  it("times out while the response body is still being read", async () => {
    const { fetch } = fakeFetch((_request, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          init.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const error = await providerError(client(fetch, { timeoutMs: 30 }).client.postJson("/x", {}));
    expect(error.message).toBe("LLM request timed out after 30 ms");
  });

  it("stops retrying when the caller aborts during backoff, with the real sleep", async () => {
    const { fetch, requests } = fakeFetch(json({}, 503), json({ never: "sent" }));
    const controller = new AbortController();
    const reason = new Error("client went away");
    const { client: c } = client(fetch, {
      sleep: abortableSleep,
      retry: { maxRetries: 2, baseDelayMs: 10_000, maxDelayMs: 10_000 },
    });
    const pending = c.postJson("/x", {}, controller.signal);
    setTimeout(() => {
      controller.abort(reason);
    }, 20);
    await expect(pending).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });
});

describe("abortableSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = abortableSleep(1_000, new AbortController().signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it("rejects with the abort reason as soon as the signal aborts, and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("stop");
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already");
    controller.abort(reason);
    await expect(abortableSleep(60_000, controller.signal)).rejects.toBe(reason);
  });
});

describe("OpenAiCompatibleClient redaction", () => {
  it("does not treat a short placeholder key as a secret", async () => {
    const { fetch } = fakeFetch(json({ error: { message: 'model "x" not found, try ollama pull x' } }, 404));
    const error = await providerError(client(fetch, { apiKey: "ollama" }).client.postJson("/x", {}));
    expect(error.message).toContain("try ollama pull x");
  });

  it("redacts other key shapes and bearer tokens", async () => {
    const { fetch } = fakeFetch(
      json({ error: { message: "Invalid key gsk_AB...1234 (sent Authorization: Bearer abc.def-ghi)" } }, 401),
    );
    const error = await providerError(client(fetch).client.postJson("/x", {}));
    expect(error.message).not.toContain("gsk_AB");
    expect(error.message).not.toContain("abc.def");
    expect(error.message).toContain("Bearer [redacted]");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
