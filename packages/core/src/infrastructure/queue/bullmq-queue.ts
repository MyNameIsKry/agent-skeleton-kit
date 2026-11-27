/**
 * BullMQ adapters for the ingestion queue (design.md section 6).
 *
 * - Job id `${tenantId}--${docId}--v${version}--${nonce}`: unique per enqueue. BullMQ ignores
 *   an `add` whose id already exists, and kept jobs would collide when a removed document comes
 *   back at version 1. Duplicate work is prevented by `sync`, not by job ids.
 * - 3 attempts with exponential backoff from 2 s. Non-retryable ingest and provider errors
 *   become an UnrecoverableError, which stops retries at once.
 * - The producer fails fast when Redis is unreachable; the worker uses blocking connections.
 */
import { randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from "bullmq";
import { z } from "zod";
import { InfrastructureUnavailableError, isRetryable } from "../../domain/errors.js";
import type {
  IngestJob,
  IngestJobHandler,
  IngestJobInput,
  JobConsumer,
  JobQueue,
  Logger,
} from "../../domain/ports.js";
import type { TenantContext } from "../../domain/tenant.js";

export const INGEST_QUEUE = "ingest";
export const INGEST_JOB_NAME = "ingest-document";
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 2_000;
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
/** After cancelling active jobs on close, how long to wait for them to stop. */
export const CANCEL_GRACE_MS = 5_000;

export interface BullMqOptions {
  redisUrl: string;
  /** Redis key prefix. Tests use a unique prefix per run. */
  prefix?: string;
  logger?: Logger;
}

/** Workers need `maxRetriesPerRequest: null`: their blocking commands must wait for Redis. */
export function workerConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/** Producers must fail instead of queueing commands forever while Redis is down. */
export function producerConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: 1, connectTimeout: 5_000 };
}

export const ingestJobId = (tenantId: string, docId: string, version: number, nonce: string): string =>
  `${tenantId}--${docId}--v${version}--${nonce}`;

/** Job data comes back from Redis, so it is validated before it reaches the handler. */
const jobSchema = z.strictObject({
  tenantId: z.string().min(1),
  docId: z.string().min(1),
  source: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.int().min(1),
});

/** Resolves true if `promise` settles within `ms`, false otherwise. Never rejects. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class BullMqJobQueue implements JobQueue {
  readonly #queue: Queue<IngestJob>;
  readonly #enqueueTimeoutMs: number;

  constructor(options: BullMqOptions & { attempts?: number; backoffMs?: number; enqueueTimeoutMs?: number }) {
    this.#enqueueTimeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;
    this.#queue = new Queue<IngestJob>(INGEST_QUEUE, {
      connection: producerConnection(options.redisUrl),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      defaultJobOptions: {
        attempts: options.attempts ?? DEFAULT_ATTEMPTS,
        backoff: { type: "exponential", delay: options.backoffMs ?? DEFAULT_BACKOFF_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    });
    // Without a listener, a connection error event would crash the process.
    this.#queue.on("error", (error) => {
      options.logger?.error({ error: error.message }, "Ingestion queue connection error");
    });
  }

  async enqueueIngest(ctx: TenantContext, job: IngestJobInput): Promise<void> {
    // The tenant comes from the context, never from the caller's payload.
    const data: IngestJob = { ...job, tenantId: ctx.tenantId };
    const jobId = ingestJobId(ctx.tenantId, job.docId, job.version, randomUUID().slice(0, 12));
    const adding = this.#queue.add(INGEST_JOB_NAME, data, { jobId });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${this.#enqueueTimeoutMs} ms`));
      }, this.#enqueueTimeoutMs);
    });
    try {
      await Promise.race([adding, timeout]);
    } catch (error) {
      // If the add completes later, the job simply runs; if not, sync re-enqueues the stale document.
      adding.catch(() => undefined);
      throw new InfrastructureUnavailableError(
        "Could not enqueue the ingestion job. Check REDIS_URL and that Redis is running.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

export interface BullMqJobConsumerOptions extends BullMqOptions {
  concurrency?: number;
  closeTimeoutMs?: number;
  cancelGraceMs?: number;
}

export class BullMqJobConsumer implements JobConsumer {
  readonly #options: BullMqJobConsumerOptions;
  #worker: Worker<IngestJob> | undefined;

  constructor(options: BullMqJobConsumerOptions) {
    this.#options = options;
  }

  process(handler: IngestJobHandler): void {
    if (this.#worker !== undefined) throw new Error("BullMqJobConsumer.process was already called");
    const { logger } = this.#options;

    this.#worker = new Worker<IngestJob>(
      INGEST_QUEUE,
      async (job: Job<IngestJob>, _token?: string, signal?: AbortSignal) => {
        const parsed = jobSchema.safeParse(job.data);
        if (!parsed.success) {
          throw new UnrecoverableError(`Malformed ingestion job ${String(job.id)}`);
        }
        try {
          await handler(
            parsed.data,
            { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 },
            signal,
          );
        } catch (error) {
          if (!isRetryable(error)) {
            throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      },
      {
        connection: workerConnection(this.#options.redisUrl),
        ...(this.#options.prefix === undefined ? {} : { prefix: this.#options.prefix }),
        concurrency: this.#options.concurrency ?? 2,
      },
    );
    this.#worker.on("error", (error) => {
      logger?.error({ error: error.message }, "Ingestion worker error");
    });
    this.#worker.on("stalled", (jobId) => {
      logger?.warn({ jobId }, "Ingestion job stalled (its worker stopped responding); BullMQ will retry it");
    });
    this.#worker.on("failed", (job, error) => {
      if (job === undefined) return;
      const permanent = error.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!permanent) return;
      // A job BullMQ fails for stalling never reaches the handler, so its document is not
      // marked failed. It stays pending or processing, and the next sync re-enqueues it once
      // it is stale.
      logger?.error(
        { jobId: job.id, tenantId: job.data.tenantId, source: job.data.source, error: error.message },
        "Ingestion job failed permanently",
      );
    });
  }

  /**
   * Stops taking jobs and waits for active ones up to `closeTimeoutMs`. Then it aborts them
   * through their signal (they are retried by the next worker) and waits a short grace period.
   * Never waits longer than closeTimeoutMs + cancelGraceMs.
   */
  async close(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) return;
    const { logger } = this.#options;
    const timeoutMs = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    const graceMs = this.#options.cancelGraceMs ?? CANCEL_GRACE_MS;

    const closing = worker.close();
    if (await settlesWithin(closing, timeoutMs)) return;

    logger?.warn({ timeoutMs }, "Active ingestion jobs did not finish in time; cancelling them");
    worker.cancelAllJobs("The ingestion worker is shutting down");
    if (await settlesWithin(closing, graceMs)) return;

    logger?.error({ graceMs }, "Ingestion jobs did not stop after cancellation; no longer waiting for them");
  }
}
