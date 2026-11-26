/**
 * BullMQ adapters for the ingestion queue (design.md section 6).
 *
 * - Job id `${tenantId}--${docId}--v${version}`: one job per document version. BullMQ keeps
 *   failed jobs, so a content-hash id would block re-ingesting the same content after a failure.
 * - 3 attempts with exponential backoff from 2 s. A non-retryable IngestError becomes an
 *   UnrecoverableError, which stops retries at once.
 */
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from "bullmq";
import { z } from "zod";
import { IngestError, InfrastructureUnavailableError } from "../../domain/errors.js";
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
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

export interface BullMqOptions {
  redisUrl: string;
  /** Redis key prefix. Tests use a unique prefix per run. */
  prefix?: string;
  logger?: Logger;
}

/** Workers need `maxRetriesPerRequest: null` (blocking commands); queues accept it too. */
export function redisConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

export const ingestJobId = (tenantId: string, docId: string, version: number): string =>
  `${tenantId}--${docId}--v${version}`;

/** Job data comes back from Redis, so it is validated before it reaches the handler. */
const jobSchema = z.strictObject({
  tenantId: z.string().min(1),
  docId: z.string().min(1),
  source: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.int().min(1),
});

export class BullMqJobQueue implements JobQueue {
  readonly #queue: Queue<IngestJob>;

  constructor(options: BullMqOptions & { attempts?: number; backoffMs?: number }) {
    this.#queue = new Queue<IngestJob>(INGEST_QUEUE, {
      connection: redisConnection(options.redisUrl),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      defaultJobOptions: {
        attempts: options.attempts ?? DEFAULT_ATTEMPTS,
        backoff: { type: "exponential", delay: options.backoffMs ?? DEFAULT_BACKOFF_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    });
  }

  async enqueueIngest(ctx: TenantContext, job: IngestJobInput): Promise<void> {
    // The tenant comes from the context, never from the caller's payload.
    const data: IngestJob = { ...job, tenantId: ctx.tenantId };
    try {
      await this.#queue.add(INGEST_JOB_NAME, data, {
        jobId: ingestJobId(ctx.tenantId, job.docId, job.version),
      });
    } catch (error) {
      throw new InfrastructureUnavailableError(
        "Could not enqueue the ingestion job. Check REDIS_URL and that Redis is running.",
        {
          cause: error,
        },
      );
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

export interface BullMqJobConsumerOptions extends BullMqOptions {
  concurrency?: number;
  closeTimeoutMs?: number;
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
      async (job: Job<IngestJob>) => {
        const parsed = jobSchema.safeParse(job.data);
        if (!parsed.success) {
          throw new UnrecoverableError(`Malformed ingestion job ${String(job.id)}`);
        }
        try {
          await handler(parsed.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 1,
          });
        } catch (error) {
          if (error instanceof IngestError && !error.retryable) throw new UnrecoverableError(error.message);
          throw error;
        }
      },
      {
        connection: redisConnection(this.#options.redisUrl),
        ...(this.#options.prefix === undefined ? {} : { prefix: this.#options.prefix }),
        concurrency: this.#options.concurrency ?? 2,
      },
    );
    this.#worker.on("error", (error) => {
      logger?.error({ error: error.message }, "Ingestion worker error");
    });
  }

  /** Stops taking jobs and waits for active ones; gives up waiting after the timeout. */
  async close(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) return;
    const timeoutMs = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([worker.close().then(() => "closed" as const), timedOut]);
      if (outcome === "timeout") {
        this.#options.logger?.warn(
          { timeoutMs },
          "Active ingestion jobs did not finish in time; forcing close",
        );
        await worker.close(true);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
