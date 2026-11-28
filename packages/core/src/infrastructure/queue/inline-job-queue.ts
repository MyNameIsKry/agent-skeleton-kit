/**
 * A JobQueue that runs each job in-process as soon as it is enqueued, with a single attempt.
 * Used by the `ingest` CLI and by tests, so neither needs Redis or a worker.
 */
import type { IngestJobHandler, IngestJobInput, JobQueue } from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";

export interface InlineJobResult {
  source: string;
  ok: boolean;
  error?: string;
}

export class InlineJobQueue implements JobQueue {
  readonly results: InlineJobResult[] = [];
  #handler: IngestJobHandler | undefined;

  process(handler: IngestJobHandler): void {
    this.#handler = handler;
  }

  async enqueueIngest(ctx: TenantContext, job: IngestJobInput): Promise<void> {
    if (this.#handler === undefined) throw new Error("InlineJobQueue has no handler; call process() first");
    try {
      await this.#handler({ ...job, tenantId: ctx.tenantId }, { attempt: 1, maxAttempts: 1 });
      this.results.push({ source: job.source, ok: true });
    } catch (error) {
      // The handler already marked the document failed; the sync continues with other files.
      this.results.push({
        source: job.source,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
