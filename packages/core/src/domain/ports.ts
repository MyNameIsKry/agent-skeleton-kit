/**
 * Ports: the interfaces through which application code reaches the outside world.
 * Every method that touches tenant data takes a TenantContext first.
 */
import type { NewChunk, RetrievedChunk } from "./chunk.js";
import type { Message, ToolCall } from "./conversation.js";
import type { DocumentRecord, DocumentStatus } from "./document.js";
import type { KnowledgeFile, KnowledgeFileContent, ParsedDocument } from "./knowledge.js";
import type { JsonSchema, JsonValue } from "./json.js";
import type { TenantContext, TenantSummary } from "./tenant.js";
import type { ArgsValidationIssue, ArgsValidationResult, TenantDataStore, ToolHandler } from "./tool.js";

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
  /**
   * Applies the update only while the document is still at this version, so a job for an
   * older version cannot overwrite the status of a newer one.
   */
  version?: number;
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
   * Throws DocumentNotFoundError if the document does not exist for this tenant.
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

// --- Knowledge and ingestion ---------------------------------------------------------

export interface KnowledgeSource {
  /**
   * Supported files under the tenant's `knowledge/` directory, sorted by source. Unsupported
   * files and paths that resolve outside the directory are skipped with a warning.
   */
  list(ctx: TenantContext): Promise<KnowledgeFile[]>;
  // list throws InfrastructureUnavailableError when an entry exists but cannot be read
  // (permissions, I/O). Skipping it would make sync delete a document whose file still exists.
  /**
   * Reads one file by source. `source` is untrusted (it travels through the queue): it must
   * resolve inside the tenant's `knowledge/` directory. Throws a non-retryable IngestError
   * when the file is missing, outside, unsupported, or too large.
   */
  read(ctx: TenantContext, source: string): Promise<KnowledgeFileContent>;
}

export interface DocumentParser {
  /** Throws a non-retryable IngestError for unsupported or malformed files. */
  parse(source: string, bytes: Uint8Array): Promise<ParsedDocument>;
}

/** What the API side enqueues. The queue adds the tenant from the TenantContext. */
export interface IngestJobInput {
  docId: string;
  source: string;
  contentHash: string;
  version: number;
}

/** What the worker side receives. `tenantId` is resolved through the TenantRegistry before use. */
export interface IngestJob extends IngestJobInput {
  tenantId: string;
}

export interface IngestAttempt {
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
}

export type IngestJobHandler = (
  job: IngestJob,
  attempt: IngestAttempt,
  signal?: AbortSignal,
) => Promise<void>;

export interface JobQueue {
  enqueueIngest(ctx: TenantContext, job: IngestJobInput): Promise<void>;
  close(): Promise<void>;
}

export interface JobConsumer {
  /**
   * Starts processing. A non-retryable IngestError or ProviderError from the handler stops
   * retries for that job. The signal aborts when the consumer is closing and the job must stop.
   */
  process(handler: IngestJobHandler): void;
  /** Stops taking jobs and waits for active jobs, within a bounded time. */
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

export type ToolErrorCode =
  "unknown_tool" | "validation_failed" | "handler_error" | "timeout" | "invalid_result";

export interface ToolError {
  code: ToolErrorCode;
  /** Written for the model: what went wrong and what it can do about it. */
  message: string;
  /** For `validation_failed`: the schema errors. */
  details?: readonly ArgsValidationIssue[];
}

/** Every result carries how long the call took, for the API response and the Playground. */
export type ToolExecutionResult =
  { ok: true; result: JsonValue; durationMs: number } | { ok: false; error: ToolError; durationMs: number };

export interface ToolInvocation {
  sessionId: string;
  name: string;
  /** Untrusted model output: validated against the tool's schema before anything runs. */
  arguments: unknown;
  /** Aborts when the request is cancelled. The runtime then throws the abort reason. */
  signal: AbortSignal;
}

/** A tool a source can run for a tenant: what the model sees, how to check its arguments, how to run it. */
export interface RunnableTool {
  readonly spec: LlmToolSpec;
  readonly validateArgs: (args: unknown) => ArgsValidationResult;
  readonly run: ToolHandler;
}

/** Where a tenant's tools come from. Config files now; MCP or HTTP sources later. */
export interface ToolSource {
  /** The tenant's tools. Unknown tenants have none. */
  tools(ctx: TenantContext): readonly RunnableTool[];
}

/** What the agent loop calls. Implemented once by ToolRuntime on top of any ToolSources. */
export interface ToolExecutor {
  listTools(ctx: TenantContext): readonly LlmToolSpec[];
  /** Never throws for tool faults; returns an error result instead. Throws only on caller abort. */
  execute(ctx: TenantContext, invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

// --- Cross-cutting -------------------------------------------------------------------

export interface UsageRecorder {
  record(ctx: TenantContext, usage: TokenUsage): Promise<void>;
}

export interface Clock {
  now(): Date;
}
