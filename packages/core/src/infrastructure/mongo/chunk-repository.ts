import type { AnyBulkWriteOperation } from "mongodb";
import type { NewChunk } from "../../domain/chunk.js";
import type { ChunkRepository, Clock } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { chunksOf, documentsOf, type ChunkDoc, type MongoStore } from "./collections.js";
import { chunkId } from "./ids.js";

export class DocumentNotFoundError extends Error {
  override readonly name = "DocumentNotFoundError";
}

export interface MongoChunkRepositoryOptions {
  /** Must match the vector index. Atlas silently skips vectors of another length. */
  dimensions: number;
}

/** Every filter includes `tenantId: ctx.tenantId` (tenant-isolation rule 2). */
export class MongoChunkRepository implements ChunkRepository {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
    private readonly options: MongoChunkRepositoryOptions,
  ) {}

  async upsertMany(ctx: TenantContext, chunks: readonly NewChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      if (chunk.embedding.length !== this.options.dimensions) {
        throw new Error(
          `Chunk ${chunk.source}#${chunk.idx} has ${chunk.embedding.length} dimensions; expected ${this.options.dimensions}`,
        );
      }
    }

    const operations: AnyBulkWriteOperation<ChunkDoc>[] = chunks.map((chunk) => ({
      updateOne: {
        // tenantId in the filter: an id that already belongs to another tenant fails on the
        // unique _id instead of being overwritten.
        filter: { _id: chunkId(chunk.docId, chunk.version, chunk.idx), tenantId: ctx.tenantId },
        update: {
          $set: {
            docId: chunk.docId,
            source: chunk.source,
            version: chunk.version,
            idx: chunk.idx,
            text: chunk.text,
            embedding: [...chunk.embedding],
            embeddingModel: chunk.embeddingModel,
            meta: chunk.meta,
          },
          // New chunks start inactive. A retried job keeps the active flag of existing chunks,
          // so re-upserting an already active version does not hide it from retrieval.
          $setOnInsert: { active: false },
        },
        upsert: true,
      },
    }));
    await chunksOf(this.store).bulkWrite(operations, { ordered: false });
  }

  async activateVersion(ctx: TenantContext, docId: string, version: number): Promise<void> {
    const tenantId = ctx.tenantId;
    const session = this.store.client.startSession();
    try {
      await session.withTransaction(async () => {
        const documents = documentsOf(this.store);
        const chunks = chunksOf(this.store);

        const doc = await documents.findOne({ _id: docId, tenantId }, { session });
        if (doc === null)
          throw new DocumentNotFoundError(`Document ${docId} not found for tenant ${tenantId}`);
        // A late job for an older version must not replace a newer active version.
        if (doc.activeVersion !== null && version < doc.activeVersion) return;

        await chunks.updateMany({ tenantId, docId, version }, { $set: { active: true } }, { session });
        await chunks.updateMany(
          { tenantId, docId, version: { $ne: version }, active: true },
          { $set: { active: false } },
          { session },
        );
        const chunkCount = await chunks.countDocuments({ tenantId, docId, version }, { session });

        const isLatest = version >= doc.version;
        await documents.updateOne(
          { _id: docId, tenantId },
          isLatest
            ? {
                $set: { activeVersion: version, chunkCount, status: "ready", updatedAt: this.clock.now() },
                $unset: { error: "" },
              }
            : { $set: { activeVersion: version, chunkCount, updatedAt: this.clock.now() } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async deleteVersionsBefore(ctx: TenantContext, docId: string, version: number): Promise<void> {
    await chunksOf(this.store).deleteMany({ tenantId: ctx.tenantId, docId, version: { $lt: version } });
  }

  async deleteByDocument(ctx: TenantContext, docId: string): Promise<void> {
    await chunksOf(this.store).deleteMany({ tenantId: ctx.tenantId, docId });
  }
}
