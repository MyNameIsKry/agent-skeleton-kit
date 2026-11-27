/**
 * Typed application errors. `message` is for logs and operators; `safeMessage` is the
 * only text that may reach an HTTP client.
 */

export type ErrorCode =
  | "config_error"
  | "tenant_not_found"
  | "provider_error"
  | "infrastructure_unavailable"
  | "document_not_found"
  | "ingest_failed";

export interface AppErrorOptions {
  cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly safeMessage: string;

  protected constructor(message: string, safeMessage: string, options?: AppErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.safeMessage = safeMessage;
  }
}

/** Invalid environment or tenant configuration. Raised at startup; the process should exit. */
export class ConfigurationError extends AppError {
  readonly code = "config_error";
  readonly httpStatus = 500;
  readonly issues: readonly string[];

  constructor(summary: string, issues: readonly string[], footer?: string) {
    const lines = [summary, ...issues.map((issue) => `  - ${issue}`)];
    if (footer !== undefined) lines.push(footer);
    super(lines.join("\n"), "Server configuration error.");
    this.issues = Object.freeze([...issues]);
  }
}

export class TenantNotFoundError extends AppError {
  readonly code = "tenant_not_found";
  readonly httpStatus = 404;

  constructor(tenantId: string) {
    super(`Unknown tenant: ${JSON.stringify(tenantId)}`, "Unknown tenant.");
  }
}

/** An LLM or embedding provider failed. Details stay in `message` and `cause`, never in `safeMessage`. */
export class ProviderError extends AppError {
  readonly code = "provider_error";
  readonly httpStatus = 502;
  /**
   * False when another attempt cannot succeed: a 4xx other than 429 (bad key, unknown model,
   * invalid request), a malformed response, or a dimension mismatch.
   */
  readonly retryable: boolean;

  constructor(message: string, options?: AppErrorOptions & { retryable?: boolean }) {
    super(message, "The AI provider is unavailable. Please try again.", options);
    this.retryable = options?.retryable ?? true;
  }
}

/** MongoDB or Redis is unreachable or not ready (for example the vector index is still building). */
export class InfrastructureUnavailableError extends AppError {
  readonly code = "infrastructure_unavailable";
  readonly httpStatus = 503;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, "The service is temporarily unavailable. Please try again.", options);
  }
}

/** The document does not exist for this tenant (deleted, or never created). */
export class DocumentNotFoundError extends AppError {
  readonly code = "document_not_found";
  readonly httpStatus = 404;

  constructor(docId: string, tenantId: string) {
    super(`Document ${docId} not found for tenant ${tenantId}`, "Document not found.");
  }
}

/**
 * An ingestion failure whose message is safe to show as a document's error: it names the
 * file and the problem, never provider responses or database details.
 * `retryable: false` means another attempt cannot succeed (missing or changed file, parse
 * error, unknown tenant), so the queue stops retrying at once.
 */
export class IngestError extends AppError {
  readonly code = "ingest_failed";
  readonly httpStatus = 422;

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: AppErrorOptions,
  ) {
    super(message, message, options);
  }
}

/** Whether another attempt can succeed. Unknown errors are assumed transient. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof IngestError) return error.retryable;
  if (error instanceof ProviderError) return error.retryable;
  return true;
}
