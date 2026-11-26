/**
 * In-memory DocumentRepository and ChunkRepository with the same tenant scoping and version
 * rules as the MongoDB adapters, for fast tests without a database.
 */
import { createHash } from "node:crypto";
import type { Chunk, NewChunk } from "../domain/chunk.js";
import type { DocumentRecord } from "../domain/document.js";
import type { ChunkRepository, Clock, DocumentRepository, DocumentStatusUpdate } from "../domain/ports.js";
import type { TenantContext } from "../domain/tenant.js";

const hash = (...parts: (string | number)[]): string =>
  createHash("sha256").update(parts.map(String).join("\0")).digest("hex");

const systemClock: Clock = { now: () => new Date() };

export class InMemoryDocumentRepository implements DocumentRepository {
  /** Keyed by document id. Exposed for assertions; do not mutate in tests. */
  readonly records = new Map<string, DocumentRecord>();

  constructor(private readonly clock: Clock = systemClock) {}

  #get(ctx: TenantContext, docId: string): DocumentRecord | undefined {
    const record = this.records.get(docId);
    return record?.tenantId === ctx.tenantId ? record : undefined;
  }

  upsertPending(ctx: TenantContext, input: { source: string; contentHash: string }): Promise<DocumentRecord> {
    const id = hash("doc", ctx.tenantId, input.source);
    const existing = this.#get(ctx, id);
    const record: DocumentRecord = {
      id,
      tenantId: ctx.tenantId,
      source: input.source,
      contentHash: input.contentHash,
      version: (existing?.version ?? 0) + 1,
      activeVersion: existing?.activeVersion ?? null,
      status: "pending",
      chunkCount: existing?.chunkCount ?? 0,
      updatedAt: this.clock.now(),
    };
    this.records.set(id, record);
    return Promise.resolve({ ...record });
  }

  findBySource(ctx: TenantContext, source: string): Promise<DocumentRecord | null> {
    const record = this.#get(ctx, hash("doc", ctx.tenantId, source));
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  setStatus(ctx: TenantContext, docId: string, update: DocumentStatusUpdate): Promise<void> {
    const record = this.#get(ctx, docId);
    if (record === undefined || (update.version !== undefined && record.version !== update.version)) {
      return Promise.resolve();
    }
    const next: DocumentRecord = { ...record, status: update.status, updatedAt: this.clock.now() };
    if (update.chunkCount !== undefined) next.chunkCount = update.chunkCount;
    if (update.status === "failed") next.error = update.error ?? "Unknown error";
    else delete next.error;
    this.records.set(docId, next);
    return Promise.resolve();
  }

  list(ctx: TenantContext): Promise<DocumentRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) => record.tenantId === ctx.tenantId)
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((record) => ({ ...record })),
    );
  }

  deleteBySource(ctx: TenantContext, source: string): Promise<void> {
    const id = hash("doc", ctx.tenantId, source);
    if (this.#get(ctx, id) !== undefined) this.records.delete(id);
    return Promise.resolve();
  }
}

export class InMemoryChunkRepository implements ChunkRepository {
  /** Keyed by chunk id. Exposed for assertions; do not mutate in tests. */
  readonly records = new Map<string, Chunk>();

  constructor(
    private readonly documents: InMemoryDocumentRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Chunks of one tenant, sorted by document, version, and index. */
  chunksOf(ctx: TenantContext): Chunk[] {
    return [...this.records.values()]
      .filter((chunk) => chunk.tenantId === ctx.tenantId)
      .sort((a, b) => a.docId.localeCompare(b.docId) || a.version - b.version || a.idx - b.idx);
  }

  upsertMany(ctx: TenantContext, chunks: readonly NewChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const id = hash("chunk", chunk.docId, chunk.version, chunk.idx);
      const existing = this.records.get(id);
      if (existing !== undefined && existing.tenantId !== ctx.tenantId) {
        return Promise.reject(new Error(`Chunk ${id} belongs to another tenant`));
      }
      this.records.set(id, {
        ...chunk,
        id,
        tenantId: ctx.tenantId,
        embedding: [...chunk.embedding],
        active: existing?.active ?? false,
      });
    }
    return Promise.resolve();
  }

  activateVersion(ctx: TenantContext, docId: string, version: number): Promise<void> {
    const doc = this.documents.records.get(docId);
    if (doc?.tenantId !== ctx.tenantId) {
      return Promise.reject(new Error(`Document ${docId} not found for tenant ${ctx.tenantId}`));
    }
    if (doc.activeVersion !== null && version < doc.activeVersion) return Promise.resolve();

    let chunkCount = 0;
    for (const [id, chunk] of this.records) {
      if (chunk.tenantId !== ctx.tenantId || chunk.docId !== docId) continue;
      const active = chunk.version === version;
      if (active) chunkCount++;
      if (chunk.active !== active) this.records.set(id, { ...chunk, active });
    }
    const isLatest = version >= doc.version;
    const next: DocumentRecord = { ...doc, activeVersion: version, chunkCount, updatedAt: this.clock.now() };
    if (isLatest) {
      next.status = "ready";
      delete next.error;
    }
    this.documents.records.set(docId, next);
    return Promise.resolve();
  }

  deleteVersionsBefore(ctx: TenantContext, docId: string, version: number): Promise<void> {
    for (const [id, chunk] of this.records) {
      if (chunk.tenantId === ctx.tenantId && chunk.docId === docId && chunk.version < version)
        this.records.delete(id);
    }
    return Promise.resolve();
  }

  deleteByDocument(ctx: TenantContext, docId: string): Promise<void> {
    for (const [id, chunk] of this.records) {
      if (chunk.tenantId === ctx.tenantId && chunk.docId === docId) this.records.delete(id);
    }
    return Promise.resolve();
  }
}
