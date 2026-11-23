/** Stored shapes and names of the MongoDB collections (design.md section 5). */
import type { Collection, Db, MongoClient, ObjectId } from "mongodb";
import type { ChunkMeta } from "../../domain/chunk.js";
import type { Message } from "../../domain/conversation.js";
import type { DocumentStatus } from "../../domain/document.js";

export const COLLECTIONS = {
  documents: "documents",
  chunks: "chunks",
  conversations: "conversations",
  toolRecords: "tool_records",
} as const;

export const VECTOR_INDEX_NAME = "chunk_vectors";

export interface DocumentDoc {
  _id: string;
  tenantId: string;
  source: string;
  contentHash: string;
  version: number;
  activeVersion: number | null;
  status: DocumentStatus;
  error?: string;
  chunkCount: number;
  updatedAt: Date;
}

export interface ChunkDoc {
  _id: string;
  tenantId: string;
  docId: string;
  source: string;
  version: number;
  idx: number;
  active: boolean;
  text: string;
  embedding: number[];
  embeddingModel: string;
  meta: ChunkMeta;
}

export interface ConversationDoc {
  _id?: ObjectId;
  tenantId: string;
  sessionId: string;
  messages: Message[];
  updatedAt: Date;
}

export interface ToolRecordDoc {
  _id?: ObjectId;
  tenantId: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** A connected client and the application database. Repositories receive this, never a URI. */
export interface MongoStore {
  readonly client: MongoClient;
  readonly db: Db;
}

export const documentsOf = (store: MongoStore): Collection<DocumentDoc> =>
  store.db.collection<DocumentDoc>(COLLECTIONS.documents);
export const chunksOf = (store: MongoStore): Collection<ChunkDoc> =>
  store.db.collection<ChunkDoc>(COLLECTIONS.chunks);
export const conversationsOf = (store: MongoStore): Collection<ConversationDoc> =>
  store.db.collection<ConversationDoc>(COLLECTIONS.conversations);
export const toolRecordsOf = (store: MongoStore): Collection<ToolRecordDoc> =>
  store.db.collection<ToolRecordDoc>(COLLECTIONS.toolRecords);
