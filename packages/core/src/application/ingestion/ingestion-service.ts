/**
 * Synchronizes a tenant's knowledge files with stored documents (design.md section 6):
 * enqueue new and changed files, skip unchanged ones, remove documents whose file is gone.
 */
import type {
  ChunkRepository,
  DocumentRepository,
  JobQueue,
  KnowledgeSource,
  Logger,
} from "../../domain/ports.js";
import type { DocumentStatus } from "../../domain/document.js";
import type { TenantContext } from "../../domain/tenant.js";

export interface SyncResult {
  enqueued: { source: string; docId: string; version: number }[];
  unchanged: string[];
  removed: string[];
}

/** A stored document with the same content hash in one of these states needs no new job. */
const UP_TO_DATE: readonly DocumentStatus[] = ["pending", "processing", "ready"];

export interface IngestionServiceDeps {
  knowledge: KnowledgeSource;
  documents: DocumentRepository;
  chunks: ChunkRepository;
  queue: JobQueue;
  logger: Logger;
}

export class IngestionService {
  constructor(private readonly deps: IngestionServiceDeps) {}

  async sync(ctx: TenantContext): Promise<SyncResult> {
    const { knowledge, documents, chunks, queue, logger } = this.deps;
    const result: SyncResult = { enqueued: [], unchanged: [], removed: [] };

    const files = await knowledge.list(ctx);
    const stored = new Map((await documents.list(ctx)).map((doc) => [doc.source, doc]));

    for (const file of files) {
      const existing = stored.get(file.source);
      stored.delete(file.source);
      // A failed document is retried on the next sync even if its content did not change.
      if (existing?.contentHash === file.contentHash && UP_TO_DATE.includes(existing.status)) {
        result.unchanged.push(file.source);
        continue;
      }
      const doc = await documents.upsertPending(ctx, { source: file.source, contentHash: file.contentHash });
      await queue.enqueueIngest(ctx, {
        docId: doc.id,
        source: doc.source,
        contentHash: doc.contentHash,
        version: doc.version,
      });
      result.enqueued.push({ source: doc.source, docId: doc.id, version: doc.version });
    }

    // Whatever is left in `stored` has no file on disk any more.
    for (const doc of stored.values()) {
      await chunks.deleteByDocument(ctx, doc.id);
      await documents.deleteBySource(ctx, doc.source);
      result.removed.push(doc.source);
    }

    logger.info(
      {
        tenantId: ctx.tenantId,
        enqueued: result.enqueued.length,
        unchanged: result.unchanged.length,
        removed: result.removed.length,
      },
      "Knowledge sync finished",
    );
    return result;
  }
}
