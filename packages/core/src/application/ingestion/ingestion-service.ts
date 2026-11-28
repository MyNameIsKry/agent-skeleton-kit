/**
 * Synchronizes a tenant's knowledge files with stored documents (design.md section 6):
 * enqueue new and changed files, skip unchanged ones, remove documents whose file is gone,
 * and re-enqueue documents whose job was lost.
 */
import type { DocumentRecord } from "../../domain/document.js";
import type {
  ChunkRepository,
  Clock,
  DocumentRepository,
  JobQueue,
  KnowledgeSource,
  Logger,
} from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";

/**
 * A `pending` or `processing` document not touched for this long has lost its job (a worker
 * crashed, BullMQ gave up on a stalled job, an enqueue failed, or the CLI was interrupted).
 * The use case refreshes `updatedAt` between embedding batches, so a slow job stays fresh.
 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

export interface SyncResult {
  enqueued: {
    source: string;
    docId: string;
    version: number;
    reason: "new" | "changed" | "retry" | "stale";
  }[];
  unchanged: string[];
  removed: string[];
}

export interface IngestionServiceDeps {
  knowledge: KnowledgeSource;
  documents: DocumentRepository;
  chunks: ChunkRepository;
  queue: JobQueue;
  logger: Logger;
  clock: Clock;
}

export interface IngestionServiceOptions {
  /**
   * When a `pending` or `processing` document counts as abandoned. The CLI uses 0: an
   * explicit manual run takes over in-flight documents (their old jobs become no-ops).
   */
  staleAfterMs?: number;
}

type Decision = SyncResult["enqueued"][number]["reason"] | "unchanged";

export class IngestionService {
  readonly #staleAfterMs: number;
  /** One sync per tenant at a time in this process, so two syncs never race on deletions. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: IngestionServiceDeps,
    options: IngestionServiceOptions = {},
  ) {
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  sync(ctx: TenantContext): Promise<SyncResult> {
    const previous = this.#running.get(ctx.tenantId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#sync(ctx));
    this.#running.set(ctx.tenantId, next);
    void next.finally(() => {
      if (this.#running.get(ctx.tenantId) === next) this.#running.delete(ctx.tenantId);
    });
    return next;
  }

  #decide(existing: DocumentRecord | undefined, contentHash: string): Decision {
    if (existing === undefined) return "new";
    if (existing.contentHash !== contentHash) return "changed";
    if (existing.status === "ready") return "unchanged";
    // A failed document is retried on the next sync even if its content did not change.
    if (existing.status === "failed") return "retry";
    const age = this.deps.clock.now().getTime() - existing.updatedAt.getTime();
    return age >= this.#staleAfterMs ? "stale" : "unchanged";
  }

  async #sync(ctx: TenantContext): Promise<SyncResult> {
    const { knowledge, documents, chunks, queue, logger } = this.deps;
    const result: SyncResult = { enqueued: [], unchanged: [], removed: [] };

    // Documents first: a document created after this read (by another process) is then never
    // mistaken for one whose file was removed.
    const stored = new Map((await documents.list(ctx)).map((doc) => [doc.source, doc]));
    const files = await knowledge.list(ctx);

    for (const file of files) {
      const existing = stored.get(file.source);
      stored.delete(file.source);
      const decision = this.#decide(existing, file.contentHash);
      if (decision === "unchanged") {
        result.unchanged.push(file.source);
        continue;
      }
      if (decision === "stale") {
        logger.warn(
          {
            tenantId: ctx.tenantId,
            source: file.source,
            status: existing?.status,
            updatedAt: existing?.updatedAt,
          },
          "Re-enqueuing a document whose ingestion job was lost",
        );
      }
      // A new version: any job still running for the old one becomes a no-op.
      const doc = await documents.upsertPending(ctx, { source: file.source, contentHash: file.contentHash });
      await queue.enqueueIngest(ctx, {
        docId: doc.id,
        source: doc.source,
        contentHash: doc.contentHash,
        version: doc.version,
      });
      result.enqueued.push({ source: doc.source, docId: doc.id, version: doc.version, reason: decision });
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
