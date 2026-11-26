/**
 * Processes one ingestion job: parse, chunk, embed, store inactive, activate, clean up
 * (design.md section 6). Also the queue handler that resolves the tenant and records the final
 * failure of a job.
 */
import { IngestError, TenantNotFoundError } from "../../domain/errors.js";
import type { NewChunk } from "../../domain/chunk.js";
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

export interface IngestDocumentDeps {
  knowledge: KnowledgeSource;
  parser: DocumentParser;
  embeddings: EmbeddingProvider;
  documents: DocumentRepository;
  chunks: ChunkRepository;
  logger: Logger;
}

export interface IngestOutcome {
  chunkCount: number;
}

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

    await documents.setStatus(ctx, job.docId, { status: "processing", version: job.version });

    const file = await knowledge.read(ctx, job.source);
    if (file.contentHash !== job.contentHash) {
      throw new IngestError(`${job.source} changed after it was queued. Run ingest again.`, false);
    }

    const parsed = await parser.parse(job.source, file.bytes);
    const textChunks = chunkSections(parsed.sections, ctx.config.chunking);
    const vectors =
      textChunks.length === 0 ? [] : await embeddings.embed(textChunks.map(embeddingInput), signal);

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

    await chunks.upsertMany(ctx, newChunks);
    await chunks.activateVersion(ctx, job.docId, job.version);
    // Superseded versions are already inactive and retrieval re-checks `active`, so they can go now.
    await chunks.deleteVersionsBefore(ctx, job.docId, job.version);

    log.info({ chunkCount: newChunks.length }, "Document ingested");
    return { chunkCount: newChunks.length };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Turns a job into a use-case call. The tenant comes from the registry, never from the job
 * alone: an unknown tenant id is rejected without touching data. On the last attempt (or a
 * non-retryable error) the document is marked failed with a message, then the error is
 * re-thrown so the queue records the failure.
 */
export function createIngestJobHandler(deps: {
  registry: TenantRegistry;
  useCase: IngestDocumentUseCase;
  documents: DocumentRepository;
  logger: Logger;
}): IngestJobHandler {
  return async (job: IngestJob, attempt: IngestAttempt) => {
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
      await deps.useCase.execute(ctx, job);
    } catch (error) {
      const retryable = !(error instanceof IngestError && !error.retryable);
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
          error: messageOf(error),
          version: job.version,
        });
      }
      throw error;
    }
  };
}
