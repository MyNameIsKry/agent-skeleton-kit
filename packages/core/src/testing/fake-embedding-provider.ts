import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../domain/ports.js";

export interface FakeEmbeddingProviderOptions {
  dimensions: number;
  model?: string;
}

/**
 * Deterministic embeddings without a network: each text maps to a unit vector derived from
 * its sha256, so equal texts get equal vectors. Records every call and can be told to fail.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** Every `embed` call, in order. */
  readonly calls: string[][] = [];
  #failures: Error[] = [];

  constructor(options: FakeEmbeddingProviderOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new RangeError("dimensions must be a positive integer");
    }
    this.dimensions = options.dimensions;
    this.model = options.model ?? "fake-embedding";
  }

  /** The next `count` calls reject with `error`. */
  failNext(error: Error, count = 1): this {
    for (let i = 0; i < count; i++) this.#failures.push(error);
    return this;
  }

  /** The vector `embed` returns for `text`. */
  vectorFor(text: string): number[] {
    const values: number[] = [];
    for (let block = 0; values.length < this.dimensions; block++) {
      const digest = createHash("sha256")
        .update(`${String(block)}\0${text}`)
        .digest();
      for (let i = 0; i + 1 < digest.length && values.length < this.dimensions; i += 2) {
        values.push(digest.readUInt16BE(i) / 0xffff - 0.5);
      }
    }
    const norm = Math.hypot(...values) || 1;
    return values.map((value) => value / norm);
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    const failure = this.#failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(texts.map((text) => this.vectorFor(text)));
  }
}
