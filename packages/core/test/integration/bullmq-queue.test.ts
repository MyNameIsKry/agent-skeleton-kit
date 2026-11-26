/**
 * BullMQ adapters against real Redis (see docker-compose.test.yml), with in-memory
 * repositories and fake embeddings. Each run uses its own key prefix and removes it.
 */
import { randomUUID } from "node:crypto";
import { cp } from "node:fs/promises";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createIngestJobHandler,
  IngestDocumentUseCase,
} from "../../src/application/ingestion/ingest-document.js";
import { IngestionService } from "../../src/application/ingestion/ingestion-service.js";
import { InMemoryTenantRegistry } from "../../src/application/tenants/in-memory-tenant-registry.js";
import type { IngestAttempt, IngestJob } from "../../src/domain/ports.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import { loadTenants } from "../../src/infrastructure/config/tenant-loader.js";
import { FsKnowledgeSource } from "../../src/infrastructure/knowledge/fs-knowledge-source.js";
import { ExtensionDocumentParser } from "../../src/infrastructure/parsers/document-parser.js";
import {
  BullMqJobConsumer,
  BullMqJobQueue,
  INGEST_QUEUE,
  ingestJobId,
  redisConnection,
} from "../../src/infrastructure/queue/bullmq-queue.js";
import {
  FakeEmbeddingProvider,
  InMemoryChunkRepository,
  InMemoryDocumentRepository,
} from "../../src/testing.js";
import { FIXTURES } from "../support/fixture-paths.js";
import { recordingLogger } from "../support/ingestion.js";
import { waitFor } from "../support/mongo.js";
import { TempDirs } from "../support/temp-tenant.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const prefix = `test-${randomUUID().slice(0, 8)}`;
const temps = new TempDirs();

let registry: InMemoryTenantRegistry;
let alpha: TenantContext;
let open: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  const root = await temps.make("tenants-");
  await cp(FIXTURES.validTenants, root, { recursive: true });
  registry = new InMemoryTenantRegistry((await loadTenants(root)).map((t) => t.config));
  alpha = registry.resolve("fixture-alpha");

  // Fail with instructions instead of hanging when Redis is not running.
  const probe = new Queue("probe", {
    connection: { ...redisConnection(REDIS_URL), connectTimeout: 3_000 },
    prefix,
  });
  try {
    await Promise.race([
      probe.waitUntilReady(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("timeout"));
        }, 5_000);
      }),
    ]);
  } catch (error) {
    throw new Error(
      `These tests need Redis at ${REDIS_URL}. Start it with: docker compose -f docker-compose.yml ` +
        "-f docker-compose.test.yml up -d --wait redis (or set REDIS_URL).",
      { cause: error },
    );
  } finally {
    await probe.obliterate({ force: true }).catch(() => undefined);
    await probe.close();
  }
});

afterEach(async () => {
  await Promise.all(open.map((o) => o.close()));
  open = [];
  const queue = new Queue(INGEST_QUEUE, { connection: redisConnection(REDIS_URL), prefix });
  await queue.obliterate({ force: true });
  await queue.close();
});

afterAll(() => temps.cleanup());

function pipeline() {
  const logger = recordingLogger();
  const documents = new InMemoryDocumentRepository();
  const chunks = new InMemoryChunkRepository(documents);
  const embeddings = new FakeEmbeddingProvider({ dimensions: 4 });
  const knowledge = new FsKnowledgeSource({ logger });
  const queue = new BullMqJobQueue({ redisUrl: REDIS_URL, prefix, backoffMs: 20 });
  const consumer = new BullMqJobConsumer({ redisUrl: REDIS_URL, prefix, logger, closeTimeoutMs: 5_000 });
  open.push(consumer, queue);
  const useCase = new IngestDocumentUseCase({
    knowledge,
    parser: new ExtensionDocumentParser(),
    embeddings,
    documents,
    chunks,
    logger,
  });
  const handler = createIngestJobHandler({ registry, useCase, documents, logger });
  const attempts: (IngestAttempt & { source: string })[] = [];
  consumer.process(async (job, attempt) => {
    attempts.push({ ...attempt, source: job.source });
    await handler(job, attempt);
  });
  const service = new IngestionService({ knowledge, documents, chunks, queue, logger });
  return { documents, chunks, embeddings, queue, consumer, service, attempts };
}

const statusOf = async (p: ReturnType<typeof pipeline>, source: string) =>
  (await p.documents.findBySource(alpha, source))?.status;

describe("BullMQ ingestion", () => {
  it("processes every enqueued document through the worker", async () => {
    const p = pipeline();
    await p.service.sync(alpha);

    await waitFor(
      async () => (await p.documents.list(alpha)).every((d) => d.status === "ready"),
      "documents ready",
    );

    expect((await p.documents.list(alpha)).map((d) => [d.source, d.chunkCount])).toEqual([
      ["alpha-handbook.md", 1],
      ["onboarding-checklist.pdf", 2],
    ]);
  });

  it("retries a transient failure and then succeeds", async () => {
    const p = pipeline();
    p.embeddings.failNext(new Error("provider down"));
    await p.service.sync(alpha);

    await waitFor(
      async () => (await p.documents.list(alpha)).every((d) => d.status === "ready"),
      "documents ready",
    );

    const failedFirst = p.attempts.filter((a) => a.attempt === 2);
    expect(failedFirst).toHaveLength(1);
    expect(failedFirst[0]?.maxAttempts).toBe(3);
  });

  it("marks the document failed after the last attempt", async () => {
    const p = pipeline();
    p.embeddings.failNext(new Error("provider down"), 100);
    await p.service.sync(alpha);

    await waitFor(async () => (await statusOf(p, "alpha-handbook.md")) === "failed", "handbook failed");

    expect(p.attempts.filter((a) => a.source === "alpha-handbook.md").map((a) => a.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(await p.documents.findBySource(alpha, "alpha-handbook.md")).toMatchObject({
      error: "provider down",
    });
  });

  it("stops at once on a non-retryable error", async () => {
    const p = pipeline();
    const doc = await p.documents.upsertPending(alpha, {
      source: "../tenant.yaml",
      contentHash: "0".repeat(64),
    });
    await p.queue.enqueueIngest(alpha, {
      docId: doc.id,
      source: doc.source,
      contentHash: doc.contentHash,
      version: 1,
    });

    await waitFor(async () => (await statusOf(p, "../tenant.yaml")) === "failed", "escape attempt failed");

    expect(p.attempts.map((a) => a.attempt)).toEqual([1]);
  });

  it("adds the tenant from the context and uses one job id per document version", async () => {
    const queue = new BullMqJobQueue({ redisUrl: REDIS_URL, prefix });
    open.push(queue);
    const job = { docId: "doc-1", source: "a.md", contentHash: "a".repeat(64), version: 3 };
    await queue.enqueueIngest(alpha, job);

    const raw = new Queue<IngestJob>(INGEST_QUEUE, { connection: redisConnection(REDIS_URL), prefix });
    open.push(raw);
    const stored = await raw.getJob(ingestJobId("fixture-alpha", "doc-1", 3));
    expect(stored?.data).toEqual({ ...job, tenantId: "fixture-alpha" });
    expect(stored?.opts.attempts).toBe(3);
  });

  it("rejects malformed job data without calling the handler", async () => {
    const consumer = new BullMqJobConsumer({ redisUrl: REDIS_URL, prefix });
    open.push(consumer);
    const calls: IngestJob[] = [];
    consumer.process((job) => {
      calls.push(job);
      return Promise.resolve();
    });
    const raw = new Queue(INGEST_QUEUE, { connection: redisConnection(REDIS_URL), prefix });
    open.push(raw);
    const added = await raw.add(
      "ingest-document",
      { tenantId: "fixture-alpha", source: 42 },
      { attempts: 3 },
    );

    await waitFor(async () => (await raw.getJobState(added.id ?? "")) === "failed", "malformed job failed");

    expect(calls).toEqual([]);
    expect((await raw.getJob(added.id ?? ""))?.attemptsMade).toBe(1);
  });

  it("waits for an active job when the consumer closes", async () => {
    const consumer = new BullMqJobConsumer({ redisUrl: REDIS_URL, prefix, closeTimeoutMs: 5_000 });
    let finished = false;
    let started = false;
    consumer.process(async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      finished = true;
    });
    const queue = new BullMqJobQueue({ redisUrl: REDIS_URL, prefix });
    open.push(queue);
    await queue.enqueueIngest(alpha, {
      docId: "slow",
      source: "a.md",
      contentHash: "b".repeat(64),
      version: 1,
    });
    await waitFor(() => Promise.resolve(started), "job to start");

    await consumer.close();

    expect(finished).toBe(true);
  });
});
