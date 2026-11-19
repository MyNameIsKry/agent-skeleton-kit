export interface ChunkMeta {
  /** Markdown heading path, outermost first. */
  headingPath?: readonly string[];
  /** 1-based PDF page number. */
  page?: number;
}

export interface Chunk {
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

export interface RetrievedChunk {
  id: string;
  tenantId: string;
  source: string;
  text: string;
  score: number;
  meta: ChunkMeta;
}
