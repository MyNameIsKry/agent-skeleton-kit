export interface ChunkMeta {
  /** Markdown heading path, outermost first. */
  headingPath?: readonly string[];
  /** 1-based PDF page number. */
  page?: number;
}

export interface Chunk {
  /** Deterministic: derived by the repository from docId, version, and idx. */
  id: string;
  tenantId: string;
  docId: string;
  source: string;
  version: number;
  idx: number;
  active: boolean;
  text: string;
  embedding: readonly number[];
  embeddingModel: string;
  meta: ChunkMeta;
}

/**
 * What ingestion hands to the chunk repository. The repository derives `id`, takes `tenantId`
 * from the TenantContext (never from the caller), and stores new chunks as inactive until
 * `activateVersion` commits.
 */
export type NewChunk = Omit<Chunk, "id" | "tenantId" | "active">;

export interface RetrievedChunk {
  id: string;
  tenantId: string;
  source: string;
  text: string;
  score: number;
  meta: ChunkMeta;
}
