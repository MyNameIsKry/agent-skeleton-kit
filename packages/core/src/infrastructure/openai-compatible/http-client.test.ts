import { describe, expect, it } from "vitest";
import { fakeFetch, hang, json, recordingSleep } from "../../../test/support/fake-fetch.js";
import { ProviderError } from "../../domain/errors.js";
import {
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
    timeoutMs: 1_000,
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

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
