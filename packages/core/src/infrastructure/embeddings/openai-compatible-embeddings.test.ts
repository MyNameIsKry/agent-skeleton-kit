import { describe, expect, it } from "vitest";
import { fakeFetch, json, recordingSleep, type RecordedRequest } from "../../../test/support/fake-fetch.js";
import { ProviderError } from "../../domain/errors.js";
import { OpenAiCompatibleEmbeddings } from "./openai-compatible-embeddings.js";

const DIMENSIONS = 3;

const embeddings = (fetch: ReturnType<typeof fakeFetch>["fetch"], batchSize?: number) =>
  new OpenAiCompatibleEmbeddings({
    baseUrl: "http://localhost:11434/v1",
    apiKey: undefined,
    model: "test-embedding",
    dimensions: DIMENSIONS,
    fetch,
    sleep: recordingSleep().sleep,
    ...(batchSize === undefined ? {} : { batchSize }),
  });

/** Replies with one vector per input, [i, length, 0], in reverse index order. */
const echoVectors = (request: RecordedRequest): Promise<Response> => {
  const input = (request.body as { input: string[] }).input;
  const data = input.map((text, index) => ({
    object: "embedding",
    index,
    embedding: [index, text.length, 0],
  }));
  return Promise.resolve(json({ object: "list", data: data.reverse(), model: "test-embedding" }));
};

describe("OpenAiCompatibleEmbeddings", () => {
  it("sends batches of at most batchSize and returns vectors in input order", async () => {
    const { fetch, requests } = fakeFetch(echoVectors, echoVectors, echoVectors);
    const texts = Array.from({ length: 5 }, (_, i) => "x".repeat(i + 1));

    const vectors = await embeddings(fetch, 2).embed(texts);

    expect(requests.map((r) => (r.body as { input: string[] }).input.length)).toEqual([2, 2, 1]);
    expect(requests[0]?.body).toEqual({ model: "test-embedding", input: ["x", "xx"] });
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/embeddings");
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(vectors).toEqual([
      [0, 1, 0],
      [1, 2, 0],
      [0, 3, 0],
      [1, 4, 0],
      [0, 5, 0],
    ]);
  });

  it("uses batches of 64 by default", async () => {
    const { fetch, requests } = fakeFetch(echoVectors, echoVectors, echoVectors);
    await embeddings(fetch).embed(Array.from({ length: 130 }, (_, i) => `t${i}`));
    expect(requests.map((r) => (r.body as { input: string[] }).input.length)).toEqual([64, 64, 2]);
  });

  it("makes no request for an empty list", async () => {
    const { fetch, requests } = fakeFetch();
    await expect(embeddings(fetch).embed([])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("rejects empty text before calling the provider", async () => {
    const { fetch, requests } = fakeFetch();
    await expect(embeddings(fetch).embed(["ok", "  "])).rejects.toThrow(
      new RangeError("Cannot embed empty text (input 1)"),
    );
    expect(requests).toHaveLength(0);
  });

  it("fails with a message naming EMBEDDING_DIMENSIONS when the model returns another size", async () => {
    const { fetch } = fakeFetch(json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    const error = await embeddings(fetch)
      .embed(["hi"])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toBe(
      'Embedding model "test-embedding" returned 2 dimensions, but EMBEDDING_DIMENSIONS is 3. ' +
        "Set EMBEDDING_DIMENSIONS to match the model and reindex.",
    );
  });

  it("fails when the provider returns the wrong number of vectors", async () => {
    const { fetch } = fakeFetch(json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(embeddings(fetch).embed(["a", "b"])).rejects.toThrow(
      "Embedding provider returned 1 vectors for 2 inputs",
    );
  });

  it("fails when an index is missing", async () => {
    const { fetch } = fakeFetch(
      json({
        data: [
          { index: 0, embedding: [1, 2, 3] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      }),
    );
    await expect(embeddings(fetch).embed(["a", "b"])).rejects.toThrow("returned no vector for input 1");
  });

  it("reports a missing vector by its position in the full input, not in the batch", async () => {
    const duplicateIndex = json({
      data: [
        { index: 0, embedding: [1, 2, 3] },
        { index: 0, embedding: [1, 2, 3] },
      ],
    });
    const { fetch } = fakeFetch(echoVectors, duplicateIndex);
    await expect(embeddings(fetch, 2).embed(["a", "b", "c", "d"])).rejects.toThrow(
      "Embedding provider returned no vector for input 3",
    );
  });

  it("fails on a malformed response", async () => {
    const { fetch } = fakeFetch(json({ data: [{ index: 0, embedding: "nope" }] }));
    await expect(embeddings(fetch).embed(["a"])).rejects.toThrow(
      "Embedding provider returned a malformed response",
    );
  });

  it("retries a 5xx before failing the batch", async () => {
    const { fetch, requests } = fakeFetch(json({}, 503), echoVectors);
    await expect(embeddings(fetch).embed(["a"])).resolves.toEqual([[0, 1, 0]]);
    expect(requests).toHaveLength(2);
  });
});
