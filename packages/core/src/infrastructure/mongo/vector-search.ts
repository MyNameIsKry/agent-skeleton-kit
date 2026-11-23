/**
 * Vector search with three layers of tenant isolation (tenant-isolation rules 2 and 3):
 *   1. `$vectorSearch` pre-filter on `tenantId` and `active` (index-side).
 *   2. `$match` on the stored documents, which re-checks `active` because the index lags writes.
 *   3. An in-code guard that drops and logs any result that still belongs to another tenant.
 */
import { MongoServerError, type Document } from "mongodb";
import type { RetrievedChunk } from "../../domain/chunk.js";
import { InfrastructureUnavailableError } from "../../domain/errors.js";
import type { Logger, VectorSearch, VectorSearchOptions } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { chunksOf, VECTOR_INDEX_NAME, type ChunkDoc, type MongoStore } from "./collections.js";

export const MAX_TOP_K = 50;

export interface MongoVectorSearchOptions {
  dimensions: number;
  logger: Logger;
}

type SearchRow = Pick<ChunkDoc, "_id" | "tenantId" | "source" | "text" | "meta" | "active"> & {
  score: number;
};

/** Atlas candidates per requested result. More candidates trade latency for recall. */
const numCandidates = (topK: number): number => Math.min(10_000, Math.max(100, topK * 20));

export function buildSearchPipeline(
  tenantId: string,
  embedding: readonly number[],
  options: VectorSearchOptions,
): Document[] {
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector: [...embedding],
        numCandidates: numCandidates(options.topK),
        limit: options.topK,
        filter: { tenantId, active: true },
      },
    },
    {
      $project: {
        _id: 1,
        tenantId: 1,
        source: 1,
        text: 1,
        meta: 1,
        active: 1,
        // For cosine indexes Atlas reports (1 + cosine) / 2. Convert back to cosine similarity,
        // the number embedding docs and tenant configs refer to (1 = same direction, 0 = unrelated).
        score: { $subtract: [{ $multiply: [{ $meta: "vectorSearchScore" }, 2] }, 1] },
      },
    },
    // Reads the stored documents, so a chunk deactivated after indexing is excluded at once.
    { $match: { tenantId, active: true, score: { $gte: options.minScore } } },
  ];
}

export class MongoVectorSearch implements VectorSearch {
  constructor(
    private readonly store: MongoStore,
    private readonly options: MongoVectorSearchOptions,
  ) {}

  async search(
    ctx: TenantContext,
    embedding: readonly number[],
    options: VectorSearchOptions,
  ): Promise<RetrievedChunk[]> {
    if (embedding.length !== this.options.dimensions) {
      throw new RangeError(
        `Query embedding has ${embedding.length} dimensions; expected ${this.options.dimensions}`,
      );
    }
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > MAX_TOP_K) {
      throw new RangeError(`topK must be an integer between 1 and ${MAX_TOP_K}`);
    }

    let rows: SearchRow[];
    try {
      rows = await chunksOf(this.store)
        .aggregate<SearchRow>(buildSearchPipeline(ctx.tenantId, embedding, options))
        .toArray();
    } catch (error) {
      if (error instanceof MongoServerError) {
        throw new InfrastructureUnavailableError("Vector search failed", { cause: error });
      }
      throw error;
    }
    return this.guard(ctx, rows);
  }

  /** Fail closed: anything that is not an active chunk of this tenant never leaves the adapter. */
  private guard(ctx: TenantContext, rows: readonly SearchRow[]): RetrievedChunk[] {
    const results: RetrievedChunk[] = [];
    for (const row of rows) {
      if (row.tenantId !== ctx.tenantId || !row.active) {
        // Ids only: never log another tenant's text.
        this.options.logger.error(
          { tenantId: ctx.tenantId, chunkId: row._id, chunkTenantId: row.tenantId, active: row.active },
          "Dropped a vector search result that does not belong to the requesting tenant",
        );
        continue;
      }
      results.push({
        id: row._id,
        tenantId: row.tenantId,
        source: row.source,
        text: row.text,
        score: row.score,
        meta: row.meta,
      });
    }
    return results;
  }
}
