/**
 * Ports: the interfaces through which application code reaches the outside world.
 * Every method that touches tenant data takes a TenantContext first.
 */
import type { Chunk, RetrievedChunk } from "./chunk.js";
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
  /** Creates or updates the document for `source` and marks it pending with a new version. */
  upsertPending(ctx: TenantContext, input: { source: string; contentHash: string }): Promise<DocumentRecord>;
  findBySource(ctx: TenantContext, source: string): Promise<DocumentRecord | null>;
  setStatus(ctx: TenantContext, docId: string, update: DocumentStatusUpdate): Promise<void>;
  list(ctx: TenantContext): Promise<DocumentRecord[]>;
  deleteBySource(ctx: TenantContext, source: string): Promise<void>;
}

export interface ChunkRepository {
  /** Idempotent: chunk ids are deterministic, so retries overwrite instead of duplicating. */
  upsertMany(ctx: TenantContext, chunks: readonly Chunk[]): Promise<void>;
  /** Atomically makes `version` the only active version of the document and marks it ready. */
  activateVersion(ctx: TenantContext, docId: string, version: number): Promise<void>;
  deleteVersionsExcept(ctx: TenantContext, docId: string, keepVersion: number): Promise<void>;
  deleteByDocument(ctx: TenantContext, docId: string): Promise<void>;
}

export interface VectorSearchOptions {
  topK: number;
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
  /** Throws ProviderError on failure. */
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
