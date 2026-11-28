import { createHash } from "node:crypto";
import { IngestError } from "../../src/domain/errors.js";
import type { KnowledgeFile, KnowledgeFileContent } from "../../src/domain/knowledge.js";
import type { IngestJob, IngestJobInput, JobQueue, KnowledgeSource, Logger } from "../../src/domain/ports.js";
import type { TenantContext } from "../../src/domain/tenant.js";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Knowledge files per tenant, held in memory. */
export class InMemoryKnowledgeSource implements KnowledgeSource {
  readonly #files = new Map<string, Map<string, string>>();

  set(ctx: TenantContext, source: string, text: string): this {
    const files = this.#files.get(ctx.tenantId) ?? new Map<string, string>();
    files.set(source, text);
    this.#files.set(ctx.tenantId, files);
    return this;
  }

  remove(ctx: TenantContext, source: string): this {
    this.#files.get(ctx.tenantId)?.delete(source);
    return this;
  }

  list(ctx: TenantContext): Promise<KnowledgeFile[]> {
    const files = [...(this.#files.get(ctx.tenantId) ?? new Map<string, string>())].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Promise.resolve(
      files.map(([source, text]) => ({ source, contentHash: sha256(text), sizeBytes: text.length })),
    );
  }

  read(ctx: TenantContext, source: string): Promise<KnowledgeFileContent> {
    const text = this.#files.get(ctx.tenantId)?.get(source);
    if (text === undefined) return Promise.reject(new IngestError(`${source} no longer exists`, false));
    return Promise.resolve({ bytes: new TextEncoder().encode(text), contentHash: sha256(text) });
  }
}

/** Records enqueued jobs without running them. */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: IngestJob[] = [];

  enqueueIngest(ctx: TenantContext, job: IngestJobInput): Promise<void> {
    this.jobs.push({ ...job, tenantId: ctx.tenantId });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RecordingLogger extends Logger {
  entries: { level: string; message: string; fields: Record<string, unknown> }[];
}

export function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger["entries"] = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const at =
      (level: string) =>
      (fields: Record<string, unknown>, message: string): void => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };
    return {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (more) => make({ ...bindings, ...more }),
    };
  };
  return Object.assign(make({}), { entries });
}
