/**
 * EmbeddingProvider for OpenAI-compatible `/embeddings` APIs. See design.md section 3a.
 */
import { z } from "zod";
import { ProviderError } from "../../domain/errors.js";
import type { EmbeddingProvider, Logger } from "../../domain/ports.js";
import {
  OpenAiCompatibleClient,
  type FetchFn,
  type RetryPolicy,
  type SleepFn,
} from "../openai-compatible/http-client.js";

export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;

export interface OpenAiCompatibleEmbeddingsOptions {
  baseUrl: string;
  /** Undefined: no Authorization header (for example a local server). */
  apiKey: string | undefined;
  model: string;
  /** Expected vector length (EMBEDDING_DIMENSIONS). Every returned vector is checked. */
  dimensions: number;
  batchSize?: number;
  timeoutMs?: number;
  retry?: RetryPolicy;
  fetch?: FetchFn;
  sleep?: SleepFn;
  logger?: Logger;
}

const wireResponse = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number()) })),
});

export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly #batchSize: number;
  readonly #client: OpenAiCompatibleClient;

  constructor(options: OpenAiCompatibleEmbeddingsOptions) {
    const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new RangeError("batchSize must be a positive integer");
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.#batchSize = batchSize;
    this.#client = new OpenAiCompatibleClient({
      label: "Embedding",
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  /** Returns one vector per input, in input order. Batches are sent one after another. */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.some((text) => text.trim() === "")) {
      throw new RangeError("Cannot embed empty text");
    }
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      vectors.push(...(await this.#embedBatch(texts.slice(start, start + this.#batchSize), signal)));
    }
    return vectors;
  }

  async #embedBatch(batch: readonly string[], signal: AbortSignal | undefined): Promise<number[][]> {
    const raw = await this.#client.postJson("/embeddings", { model: this.model, input: batch }, signal);
    const parsed = wireResponse.safeParse(raw);
    if (!parsed.success) throw new ProviderError("Embedding provider returned a malformed response");

    const items = parsed.data.data;
    if (items.length !== batch.length) {
      throw new ProviderError(
        `Embedding provider returned ${items.length} vectors for ${batch.length} inputs`,
      );
    }

    const byIndex = new Map(items.map((item) => [item.index, item.embedding]));
    const vectors: number[][] = [];
    for (let i = 0; i < batch.length; i++) {
      const vector = byIndex.get(i);
      if (vector === undefined)
        throw new ProviderError(`Embedding provider returned no vector for input ${i}`);
      if (vector.length !== this.dimensions) {
        throw new ProviderError(
          `Embedding model "${this.model}" returned ${vector.length} dimensions, but EMBEDDING_DIMENSIONS is ` +
            `${this.dimensions}. Set EMBEDDING_DIMENSIONS to match the model and reindex.`,
        );
      }
      vectors.push(vector);
    }
    return vectors;
  }
}
