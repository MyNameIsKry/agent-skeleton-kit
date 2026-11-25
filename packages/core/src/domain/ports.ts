/**
 * Ports: the interfaces through which application code reaches the outside world.
 * Every method that touches tenant data takes a TenantContext first.
 */
import type { NewChunk, RetrievedChunk } from "./chunk.js";
import type { Message, ToolCall } from "./conversation.js";
import type { DocumentRecord, DocumentStatus } from "./document.js";
import type { JsonSchema } from "./json.js";
import type { TenantContext, TenantSummary } from "./tenant.js";
import type { TenantDataStore } from "./tool.js";

export type { Logger, LogFields, LogFn, TenantDataStore } from "./tool.js";

// --- Tenants -------------------------------------------------------------------------

export interface TenantRegistry {
  list(): readonly TenantSummary[];
  /** Throws TenantNotFoundError for unknown ids. */
  resolve(tenantId: string): TenantContext;
}

// --- Persistence ---------------------------------------------------------------------

export interface DocumentStatusUpdate {
  status: DocumentStatus;
  error?: string;
  chunkCount?: number;
}

export interface DocumentRepository {
  /**
   * Creates the document for `source`, or bumps its version, and marks it pending.
   * The version increment is atomic, so concurrent calls get distinct versions.
   */
  upsertPending(ctx: TenantContext, input: { source: string; contentHash: string }): Promise<DocumentRecord>;
  findBySource(ctx: TenantContext, source: string): Promise<DocumentRecord | null>;
  /** Setting any status other than "failed" clears a previous error. */
  setStatus(ctx: TenantContext, docId: string, update: DocumentStatusUpdate): Promise<void>;
  list(ctx: TenantContext): Promise<DocumentRecord[]>;
  /** Deletes the document record only. Delete its chunks with ChunkRepository.deleteByDocument. */
  deleteBySource(ctx: TenantContext, source: string): Promise<void>;
}

export interface ChunkRepository {
  /**
   * Idempotent: ids derive from (docId, version, idx), so retries overwrite instead of
   * duplicating. Chunks are stored for `ctx.tenantId` and start inactive.
   */
  upsertMany(ctx: TenantContext, chunks: readonly NewChunk[]): Promise<void>;
  /**
   * In one transaction: makes `version` the only active version of the document and records it
   * as the document's active version. Marks the document ready only if `version` is its latest
   * version. A stale call (version older than the active one) changes nothing.
   * Throws if the document does not exist for this tenant.
   */
  activateVersion(ctx: TenantContext, docId: string, version: number): Promise<void>;
  /** Deletes chunks of versions older than `version`. Newer, in-progress versions are kept. */
  deleteVersionsBefore(ctx: TenantContext, docId: string, version: number): Promise<void>;
  deleteByDocument(ctx: TenantContext, docId: string): Promise<void>;
}

export interface VectorSearchOptions {
  topK: number;
  /** Minimum cosine similarity, from 0 (unrelated) to 1 (same direction). */
  minScore: number;
}

export interface VectorSearch {
  /** Returns only active chunks of `ctx.tenantId`. */
  search(
    ctx: TenantContext,
    embedding: readonly number[],
    options: VectorSearchOptions,
  ): Promise<RetrievedChunk[]>;
}

export interface ConversationRepository {
  append(ctx: TenantContext, sessionId: string, messages: readonly Message[]): Promise<void>;
  recent(ctx: TenantContext, sessionId: string, limit: number): Promise<Message[]>;
}

export interface TenantDataStoreFactory {
  forTenant(ctx: TenantContext): TenantDataStore;
}

// --- Ingestion queue -----------------------------------------------------------------

export interface IngestJob {
  tenantId: string;
  docId: string;
  source: string;
  contentHash: string;
}

export interface JobQueue {
  enqueueIngest(ctx: TenantContext, job: IngestJob): Promise<void>;
  close(): Promise<void>;
}

export interface JobConsumer {
  /** The handler resolves the tenant from the job through the TenantRegistry. */
  process(handler: (job: IngestJob) => Promise<void>): void;
  close(): Promise<void>;
}

// --- Model providers -----------------------------------------------------------------

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmChatRequest {
  messages: readonly Message[];
  tools: readonly LlmToolSpec[];
  signal: AbortSignal;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: readonly ToolCall[];
  usage?: TokenUsage;
}

export interface LlmProvider {
  /** Single place to change when streaming (SSE) is added. Throws ProviderError on failure. */
  chat(request: LlmChatRequest): Promise<LlmResponse>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /**
   * One vector per text, in input order. Texts must not be blank: callers trim and skip empty
   * input (RangeError otherwise). Throws ProviderError when the provider fails.
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

// --- Tools ---------------------------------------------------------------------------

export type ToolErrorCode = "unknown_tool" | "validation_failed" | "handler_error" | "timeout";

export type ToolExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ToolErrorCode; message: string; details?: unknown } };

export interface ToolInvocation {
  sessionId: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}

/** Source of tools for a tenant. Config files now; MCP or HTTP sources later. */
export interface ToolSource {
  listTools(ctx: TenantContext): readonly LlmToolSpec[];
  /** Never throws for tool faults; returns an error result instead. */
  execute(ctx: TenantContext, invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

// --- Cross-cutting -------------------------------------------------------------------

export interface UsageRecorder {
  record(ctx: TenantContext, usage: TokenUsage): Promise<void>;
}

export interface Clock {
  now(): Date;
}
