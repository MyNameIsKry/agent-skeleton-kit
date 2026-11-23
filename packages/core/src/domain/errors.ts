/**
 * Typed application errors. `message` is for logs and operators; `safeMessage` is the
 * only text that may reach an HTTP client.
 */

export type ErrorCode = "config_error" | "tenant_not_found" | "provider_error" | "infrastructure_unavailable";

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

  constructor(message: string, options?: AppErrorOptions) {
    super(message, "The AI provider is unavailable. Please try again.", options);
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
