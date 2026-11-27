/**
 * Processes one ingestion job: parse, chunk, embed, store inactive, activate, clean up
 * (design.md section 6). Also the queue handler that resolves the tenant and records the final
 * failure of a job.
 */
import type { NewChunk } from "../../domain/chunk.js";
import type { DocumentRecord } from "../../domain/document.js";
import {
  AppError,
  DocumentNotFoundError,
  IngestError,
  isRetryable,
  TenantNotFoundError,
} from "../../domain/errors.js";
import type {
  ChunkRepository,
  DocumentParser,
  DocumentRepository,
  EmbeddingProvider,
  IngestAttempt,
  IngestJob,
  IngestJobHandler,
  KnowledgeSource,
  Logger,
  TenantRegistry,
} from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";
import { chunkSections, embeddingInput } from "./chunker.js";

/** Texts per embedding call. `updatedAt` is refreshed between calls, so a long job stays fresh. */
export const EMBEDDING_GROUP_SIZE = 64;

export interface IngestDocumentDeps {
  knowledge: KnowledgeSource;
  parser: DocumentParser;
  embeddings: EmbeddingProvider;
  documents: DocumentRepository;
  chunks: ChunkRepository;
  logger: Logger;
}

export type IngestOutcome =
  | { status: "ingested"; chunkCount: number }
  /** A newer version was enqueued, or the document was removed: nothing was written. */
  | { status: "superseded" };

/** True when the job's version is still the document's current version for that source. */
const isCurrent = (doc: DocumentRecord | null, job: IngestJob): doc is DocumentRecord =>
  doc?.id === job.docId && doc.version === job.version;

export class IngestDocumentUseCase {
  constructor(private readonly deps: IngestDocumentDeps) {}

  async execute(ctx: TenantContext, job: IngestJob, signal?: AbortSignal): Promise<IngestOutcome> {
    const { knowledge, parser, embeddings, documents, chunks, logger } = this.deps;
    const log = logger.child({
      tenantId: ctx.tenantId,
      docId: job.docId,
      source: job.source,
      version: job.version,
    });
    const superseded = (): IngestOutcome => {
      log.info({}, "Skipping a superseded ingestion job");
      return { status: "superseded" };
    };

    // Looked up by source, then matched by id: a job whose docId and source disagree is stale
    // or forged, and does nothing.
    if (!isCurrent(await documents.findBySource(ctx, job.source), job)) return superseded();
    await documents.setStatus(ctx, job.docId, { status: "processing", version: job.version });

    const file = await knowledge.read(ctx, job.source);
    if (file.contentHash !== job.contentHash) {
      throw new IngestError(`${job.source} changed after it was queued. Run ingest again.`, false);
    }

    const parsed = await parser.parse(job.source, file.bytes);
    const textChunks = chunkSections(parsed.sections, ctx.config.chunking);
    if (textChunks.length === 0 && file.bytes.length > 0) {
      log.warn({}, "Document has no extractable text (for example a scanned PDF without a text layer)");
    }

    const inputs = textChunks.map(embeddingInput);
    const vectors: number[][] = [];
    for (let start = 0; start < inputs.length; start += EMBEDDING_GROUP_SIZE) {
      signal?.throwIfAborted();
      vectors.push(...(await embeddings.embed(inputs.slice(start, start + EMBEDDING_GROUP_SIZE), signal)));
      // Heartbeat: keeps the document from looking abandoned to the next sync.
      await documents.setStatus(ctx, job.docId, { status: "processing", version: job.version });
    }

    // Embedding can take long; do not write chunks for a version that is no longer wanted.
    if (!isCurrent(await documents.findBySource(ctx, job.source), job)) return superseded();

    const newChunks: NewChunk[] = textChunks.map((chunk, idx) => {
      const vector = vectors[idx];
      if (vector === undefined) throw new Error(`Missing embedding for chunk ${idx}`);
      return {
        docId: job.docId,
        source: job.source,
        version: job.version,
        idx,
        text: chunk.text,
        embedding: vector,
        embeddingModel: embeddings.model,
        meta: chunk.page === undefined ? { headingPath: chunk.headingPath } : { page: chunk.page },
      };
    });

    signal?.throwIfAborted();
    await chunks.upsertMany(ctx, newChunks);
    try {
      await chunks.activateVersion(ctx, job.docId, job.version);
    } catch (error) {
      if (!(error instanceof DocumentNotFoundError)) throw error;
      // Removed by a sync while this job ran: drop what was just written.
      await chunks.deleteByDocument(ctx, job.docId);
      return superseded();
    }
    // Superseded versions are already inactive and retrieval re-checks `active`, so they can go now.
    await chunks.deleteVersionsBefore(ctx, job.docId, job.version);

    log.info({ chunkCount: newChunks.length }, "Document ingested");
    return { status: "ingested", chunkCount: newChunks.length };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The message stored on a failed document, which the Playground shows. Ingest errors name
 * the file and the problem; other errors may carry provider responses or database details,
 * so only their safe message is stored. The full message goes to the logs.
 */
export function documentErrorMessage(error: unknown): string {
  if (error instanceof IngestError) return error.message;
  if (error instanceof AppError) return error.safeMessage;
  return "Ingestion failed unexpectedly. See the worker logs for details.";
}

/**
 * Turns a job into a use-case call. The tenant comes from the registry, never from the job
 * alone: an unknown tenant id is rejected without touching data. On the last attempt (or a
 * non-retryable error) the document is marked failed with a safe message, then the error is
 * re-thrown so the queue records the failure. A job aborted because the consumer is closing is
 * not marked failed: it is retried by the next worker.
 */
export function createIngestJobHandler(deps: {
  registry: TenantRegistry;
  useCase: IngestDocumentUseCase;
  documents: DocumentRepository;
  logger: Logger;
}): IngestJobHandler {
  return async (job: IngestJob, attempt: IngestAttempt, signal?: AbortSignal) => {
    let ctx: TenantContext;
    try {
      ctx = deps.registry.resolve(job.tenantId);
    } catch (error) {
      if (error instanceof TenantNotFoundError) {
        throw new IngestError(`Unknown tenant "${job.tenantId}"`, false, { cause: error });
      }
      throw error;
    }

    try {
      await deps.useCase.execute(ctx, job, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        deps.logger.warn(
          { tenantId: ctx.tenantId, docId: job.docId, source: job.source },
          "Ingestion job interrupted by shutdown",
        );
        throw error;
      }
      const retryable = isRetryable(error);
      const final = !retryable || attempt.attempt >= attempt.maxAttempts;
      deps.logger.warn(
        {
          tenantId: ctx.tenantId,
          docId: job.docId,
          source: job.source,
          attempt: attempt.attempt,
          final,
          error: messageOf(error),
        },
        "Ingestion attempt failed",
      );
      if (final) {
        await deps.documents.setStatus(ctx, job.docId, {
          status: "failed",
          error: documentErrorMessage(error),
          version: job.version,
        });
      }
      throw error;
    }
  };
}
