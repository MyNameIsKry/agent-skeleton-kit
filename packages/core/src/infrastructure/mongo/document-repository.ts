import { MongoServerError } from "mongodb";
import type { DocumentRecord } from "../../domain/document.js";
import type { Clock, DocumentRepository, DocumentStatusUpdate } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { documentsOf, type DocumentDoc, type MongoStore } from "./collections.js";
import { documentId } from "./ids.js";

const DUPLICATE_KEY = 11000;

function toRecord(doc: DocumentDoc): DocumentRecord {
  const record: DocumentRecord = {
    id: doc._id,
    tenantId: doc.tenantId,
    source: doc.source,
    contentHash: doc.contentHash,
    version: doc.version,
    activeVersion: doc.activeVersion,
    status: doc.status,
    chunkCount: doc.chunkCount,
    updatedAt: doc.updatedAt,
  };
  if (doc.error !== undefined) record.error = doc.error;
  return record;
}

/** Every filter includes `tenantId: ctx.tenantId` (tenant-isolation rule 2). */
export class MongoDocumentRepository implements DocumentRepository {
  constructor(
    private readonly store: MongoStore,
    private readonly clock: Clock,
  ) {}

  async upsertPending(
    ctx: TenantContext,
    input: { source: string; contentHash: string },
  ): Promise<DocumentRecord> {
    // Two concurrent first inserts of the same source race on the unique _id. Mongo retries
    // such upserts itself only when the filter is exactly the unique key, and ours also pins
    // tenantId. Retrying once is enough: the second attempt finds the document and updates it.
    try {
      return await this.upsertPendingOnce(ctx, input);
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) throw error;
      return this.upsertPendingOnce(ctx, input);
    }
  }

  private async upsertPendingOnce(
    ctx: TenantContext,
    input: { source: string; contentHash: string },
  ): Promise<DocumentRecord> {
    const doc = await documentsOf(this.store).findOneAndUpdate(
      { _id: documentId(ctx.tenantId, input.source), tenantId: ctx.tenantId },
      {
        $inc: { version: 1 },
        $set: {
          source: input.source,
          contentHash: input.contentHash,
          status: "pending",
          updatedAt: this.clock.now(),
        },
        $unset: { error: "" },
        $setOnInsert: { activeVersion: null, chunkCount: 0 },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (doc === null) throw new Error("upsertPending returned no document");
    return toRecord(doc);
  }

  async findBySource(ctx: TenantContext, source: string): Promise<DocumentRecord | null> {
    const doc = await documentsOf(this.store).findOne({
      _id: documentId(ctx.tenantId, source),
      tenantId: ctx.tenantId,
    });
    return doc === null ? null : toRecord(doc);
  }

  async setStatus(ctx: TenantContext, docId: string, update: DocumentStatusUpdate): Promise<void> {
    const set: Partial<DocumentDoc> = { status: update.status, updatedAt: this.clock.now() };
    if (update.chunkCount !== undefined) set.chunkCount = update.chunkCount;
    if (update.status === "failed") {
      set.error = update.error ?? "Unknown error";
      await documentsOf(this.store).updateOne({ _id: docId, tenantId: ctx.tenantId }, { $set: set });
    } else {
      await documentsOf(this.store).updateOne(
        { _id: docId, tenantId: ctx.tenantId },
        { $set: set, $unset: { error: "" } },
      );
    }
  }

  async list(ctx: TenantContext): Promise<DocumentRecord[]> {
    const docs = await documentsOf(this.store).find({ tenantId: ctx.tenantId }).sort({ source: 1 }).toArray();
    return docs.map(toRecord);
  }

  async deleteBySource(ctx: TenantContext, source: string): Promise<void> {
    await documentsOf(this.store).deleteOne({
      _id: documentId(ctx.tenantId, source),
      tenantId: ctx.tenantId,
    });
  }
}
