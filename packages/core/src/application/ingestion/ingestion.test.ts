import { describe, expect, it } from "vitest";
import {
  InMemoryKnowledgeSource,
  RecordingJobQueue,
  recordingLogger,
} from "../../../test/support/ingestion.js";
import { IngestError } from "../../domain/errors.js";
import type { ParsedDocument } from "../../domain/knowledge.js";
import type { DocumentParser, IngestJob } from "../../domain/ports.js";
import type { TenantConfig } from "../../domain/tenant.js";
import { FakeEmbeddingProvider, InMemoryChunkRepository, InMemoryDocumentRepository } from "../../testing.js";
import { InMemoryTenantRegistry } from "../tenants/in-memory-tenant-registry.js";
import { createIngestJobHandler, IngestDocumentUseCase } from "./ingest-document.js";
import { IngestionService } from "./ingestion-service.js";

const config = (id: string): TenantConfig => ({
  id,
  displayName: id,
  description: id,
  systemPrompt: id,
  retrieval: { topK: 5, minScore: 0.6 },
  chunking: { maxTokens: 20, overlap: 0 },
  tools: [],
  rootDir: `/srv/${id}`,
});
const registry = new InMemoryTenantRegistry([config("tenant-a"), config("tenant-b")]);
const tenantA = registry.resolve("tenant-a");
const tenantB = registry.resolve("tenant-b");

/** Treats every file as Markdown with one heading line, enough for these tests. */
const textParser: DocumentParser = {
  parse: (source, bytes): Promise<ParsedDocument> => {
    const text = new TextDecoder().decode(bytes);
    if (text.includes("UNPARSABLE")) return Promise.reject(new IngestError(`${source} is broken`, false));
    return Promise.resolve({ sections: [{ headingPath: [source], text }] });
  },
};

function setUp() {
  const logger = recordingLogger();
  const knowledge = new InMemoryKnowledgeSource();
  const documents = new InMemoryDocumentRepository();
  const chunks = new InMemoryChunkRepository(documents);
  const embeddings = new FakeEmbeddingProvider({ dimensions: 4 });
  const queue = new RecordingJobQueue();
  const service = new IngestionService({ knowledge, documents, chunks, queue, logger });
  const useCase = new IngestDocumentUseCase({
    knowledge,
    parser: textParser,
    embeddings,
    documents,
    chunks,
    logger,
  });
  const handler = createIngestJobHandler({ registry, useCase, documents, logger });
  /** Runs every job queued so far, as the final attempt, and forgets them. */
  const drain = async () => {
    const jobs = queue.jobs.splice(0);
    for (const job of jobs) await handler(job, { attempt: 1, maxAttempts: 1 }).catch(() => undefined);
    return jobs;
  };
  return { logger, knowledge, documents, chunks, embeddings, queue, service, useCase, handler, drain };
}

describe("IngestionService.sync", () => {
  it("enqueues new files as pending documents, with the tenant taken from the context", async () => {
    const { knowledge, queue, service, documents } = setUp();
    knowledge.set(tenantA, "a.md", "Alpha.").set(tenantA, "b.md", "Bravo.");

    const result = await service.sync(tenantA);

    expect(result.enqueued.map((e) => e.source)).toEqual(["a.md", "b.md"]);
    expect(queue.jobs.map((j) => [j.tenantId, j.source, j.version])).toEqual([
      ["tenant-a", "a.md", 1],
      ["tenant-a", "b.md", 1],
    ]);
    expect((await documents.list(tenantA)).map((d) => d.status)).toEqual(["pending", "pending"]);
  });

  it("skips unchanged files that are ready, pending, or processing, and retries failed ones", async () => {
    const { knowledge, queue, service, drain, documents } = setUp();
    knowledge.set(tenantA, "ready.md", "Ready.").set(tenantA, "broken.md", "UNPARSABLE");
    await service.sync(tenantA);
    await drain();
    expect((await documents.findBySource(tenantA, "broken.md"))?.status).toBe("failed");

    knowledge.set(tenantA, "pending.md", "Pending.");
    const retry = await service.sync(tenantA);
    expect(retry.enqueued.map((e) => e.source)).toEqual(["broken.md", "pending.md"]);
    expect(retry.unchanged).toEqual(["ready.md"]);

    // Both are now pending with the same content: nothing new to enqueue.
    const again = await service.sync(tenantA);
    expect(again.enqueued).toEqual([]);
    expect(again.unchanged).toEqual(["broken.md", "pending.md", "ready.md"]);
    expect(queue.jobs.filter((j) => j.source === "pending.md")).toHaveLength(1);
  });

  it("enqueues a new version when the content changes", async () => {
    const { knowledge, queue, service, drain } = setUp();
    knowledge.set(tenantA, "a.md", "Version one.");
    await service.sync(tenantA);
    await drain();

    knowledge.set(tenantA, "a.md", "Version two.");
    const result = await service.sync(tenantA);

    expect(result.enqueued).toEqual([expect.objectContaining({ source: "a.md", version: 2 })]);
    expect(queue.jobs[0]?.version).toBe(2);
  });

  it("removes documents and chunks whose file is gone, only for the syncing tenant", async () => {
    const { knowledge, service, drain, documents, chunks } = setUp();
    knowledge.set(tenantA, "gone.md", "Soon gone.").set(tenantB, "gone.md", "Beta keeps it.");
    await service.sync(tenantA);
    await service.sync(tenantB);
    await drain();
    expect(chunks.chunksOf(tenantA)).not.toHaveLength(0);

    knowledge.remove(tenantA, "gone.md");
    const result = await service.sync(tenantA);

    expect(result.removed).toEqual(["gone.md"]);
    expect(await documents.list(tenantA)).toEqual([]);
    expect(chunks.chunksOf(tenantA)).toEqual([]);
    expect(await documents.findBySource(tenantB, "gone.md")).toMatchObject({ status: "ready" });
    expect(chunks.chunksOf(tenantB)).not.toHaveLength(0);
  });
});

describe("IngestDocumentUseCase", () => {
  it("chunks, embeds with the heading path, activates the version, and marks the document ready", async () => {
    const { knowledge, service, drain, documents, chunks, embeddings } = setUp();
    // maxTokens 20 => 80 characters per chunk.
    const text = ["first paragraph ".repeat(3).trim(), "second paragraph ".repeat(3).trim()].join("\n\n");
    knowledge.set(tenantA, "guide.md", text);
    await service.sync(tenantA);
    await drain();

    const stored = chunks.chunksOf(tenantA);
    expect(stored.map((c) => [c.idx, c.version, c.active, c.meta])).toEqual([
      [0, 1, true, { headingPath: ["guide.md"] }],
      [1, 1, true, { headingPath: ["guide.md"] }],
    ]);
    expect(stored[0]?.text).toBe("first paragraph first paragraph first paragraph");
    expect(stored[0]?.embedding).toEqual(embeddings.vectorFor(`guide.md\n\n${stored[0]?.text ?? ""}`));
    expect(stored[0]?.embeddingModel).toBe("fake-embedding");
    expect(await documents.findBySource(tenantA, "guide.md")).toMatchObject({
      status: "ready",
      version: 1,
      activeVersion: 1,
      chunkCount: 2,
    });
  });

  it("replaces the old version: only the new one stays, and it is active", async () => {
    const { knowledge, service, drain, chunks } = setUp();
    knowledge.set(tenantA, "a.md", "Old text.");
    await service.sync(tenantA);
    await drain();
    knowledge.set(tenantA, "a.md", "New text.");
    await service.sync(tenantA);
    await drain();

    expect(chunks.chunksOf(tenantA).map((c) => [c.version, c.active, c.text])).toEqual([
      [2, true, "New text."],
    ]);
  });

  it("marks a document without text ready with zero chunks and calls no embedding", async () => {
    const { knowledge, service, drain, documents, embeddings } = setUp();
    knowledge.set(tenantA, "empty.md", "   \n\n  ");
    await service.sync(tenantA);
    await drain();
    expect(await documents.findBySource(tenantA, "empty.md")).toMatchObject({
      status: "ready",
      chunkCount: 0,
    });
    expect(embeddings.calls).toEqual([]);
  });

  it("fails without retry when the file changed after it was queued", async () => {
    const { knowledge, service, queue, handler, documents } = setUp();
    knowledge.set(tenantA, "a.md", "Queued text.");
    await service.sync(tenantA);
    knowledge.set(tenantA, "a.md", "Edited text.");

    const error = await handler(queue.jobs[0]!, { attempt: 1, maxAttempts: 3 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).retryable).toBe(false);
    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({
      status: "failed",
      error: "a.md changed after it was queued. Run ingest again.",
    });
  });
});

describe("ingest job handler", () => {
  it("keeps the document processing on a retryable failure and fails it on the last attempt", async () => {
    const { knowledge, service, queue, handler, documents, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    const job = queue.jobs[0]!;
    embeddings.failNext(new Error("provider down"), 2);

    await expect(handler(job, { attempt: 1, maxAttempts: 2 })).rejects.toThrow("provider down");
    expect((await documents.findBySource(tenantA, "a.md"))?.status).toBe("processing");

    await expect(handler(job, { attempt: 2, maxAttempts: 2 })).rejects.toThrow("provider down");
    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({
      status: "failed",
      error: "provider down",
    });
  });

  it("succeeds on a retry after a transient failure", async () => {
    const { knowledge, service, queue, handler, documents, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    embeddings.failNext(new Error("timeout"));

    await expect(handler(queue.jobs[0]!, { attempt: 1, maxAttempts: 3 })).rejects.toThrow("timeout");
    await handler(queue.jobs[0]!, { attempt: 2, maxAttempts: 3 });

    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({ status: "ready", chunkCount: 1 });
  });

  it("rejects a job for an unknown tenant without touching data", async () => {
    const { handler, documents } = setUp();
    const job: IngestJob = { tenantId: "tenant-x", docId: "d", source: "a.md", contentHash: "h", version: 1 };
    const error = await handler(job, { attempt: 1, maxAttempts: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).retryable).toBe(false);
    expect(documents.records.size).toBe(0);
  });

  it("does not overwrite the status of a newer version when an old job fails", async () => {
    const { knowledge, service, queue, handler, documents } = setUp();
    knowledge.set(tenantA, "a.md", "One.");
    await service.sync(tenantA);
    const oldJob = queue.jobs.splice(0)[0]!;
    knowledge.set(tenantA, "a.md", "Two.");
    await service.sync(tenantA);

    await handler(oldJob, { attempt: 1, maxAttempts: 1 }).catch(() => undefined);

    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({ version: 2, status: "pending" });
  });
});
