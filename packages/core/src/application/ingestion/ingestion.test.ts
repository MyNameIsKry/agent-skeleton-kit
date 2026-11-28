import { describe, expect, it } from "vitest";
import {
  InMemoryKnowledgeSource,
  RecordingJobQueue,
  recordingLogger,
} from "../../../test/support/ingestion.js";
import { IngestError, ProviderError } from "../../domain/errors.js";
import type { ParsedDocument } from "../../domain/knowledge.js";
import type { DocumentParser, EmbeddingProvider, IngestJob } from "../../domain/ports.js";
import type { TenantConfig } from "../../domain/tenant.js";
import { FakeEmbeddingProvider, InMemoryChunkRepository, InMemoryDocumentRepository } from "../../testing.js";
import { InMemoryTenantRegistry } from "../tenants/in-memory-tenant-registry.js";
import { createIngestJobHandler, documentErrorMessage, IngestDocumentUseCase } from "./ingest-document.js";
import { DEFAULT_STALE_AFTER_MS, IngestionService } from "./ingestion-service.js";

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

/** Treats every file as one section named after the file, enough for these tests. */
const textParser: DocumentParser = {
  parse: (source, bytes): Promise<ParsedDocument> => {
    const text = new TextDecoder().decode(bytes);
    if (text.includes("UNPARSABLE")) return Promise.reject(new IngestError(`${source} is broken`, false));
    return Promise.resolve({ sections: [{ headingPath: [source], text }] });
  },
};

class FakeClock {
  #now = Date.parse("2026-01-01T00:00:00Z");
  now = () => new Date(this.#now);
  advance(ms: number) {
    this.#now += ms;
  }
}

function setUp(options: { embeddings?: EmbeddingProvider } = {}) {
  const logger = recordingLogger();
  const clock = new FakeClock();
  const knowledge = new InMemoryKnowledgeSource();
  const documents = new InMemoryDocumentRepository(clock);
  const chunks = new InMemoryChunkRepository(documents, clock);
  const fake = new FakeEmbeddingProvider({ dimensions: 4 });
  const embeddings = options.embeddings ?? fake;
  const queue = new RecordingJobQueue();
  const service = new IngestionService({ knowledge, documents, chunks, queue, logger, clock });
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
  return {
    logger,
    clock,
    knowledge,
    documents,
    chunks,
    embeddings: fake,
    queue,
    service,
    useCase,
    handler,
    drain,
  };
}

describe("IngestionService.sync", () => {
  it("enqueues new files as pending documents, with the tenant taken from the context", async () => {
    const { knowledge, queue, service, documents } = setUp();
    knowledge.set(tenantA, "a.md", "Alpha.").set(tenantA, "b.md", "Bravo.");

    const result = await service.sync(tenantA);

    expect(result.enqueued.map((e) => [e.source, e.reason])).toEqual([
      ["a.md", "new"],
      ["b.md", "new"],
    ]);
    expect(queue.jobs.map((j) => [j.tenantId, j.source, j.version])).toEqual([
      ["tenant-a", "a.md", 1],
      ["tenant-a", "b.md", 1],
    ]);
    expect((await documents.list(tenantA)).map((d) => d.status)).toEqual(["pending", "pending"]);
  });

  it("skips unchanged ready and in-flight files, and retries failed ones", async () => {
    const { knowledge, queue, service, drain, documents } = setUp();
    knowledge.set(tenantA, "ready.md", "Ready.").set(tenantA, "broken.md", "UNPARSABLE");
    await service.sync(tenantA);
    await drain();
    expect((await documents.findBySource(tenantA, "broken.md"))?.status).toBe("failed");

    knowledge.set(tenantA, "pending.md", "Pending.");
    const retry = await service.sync(tenantA);
    expect(retry.enqueued.map((e) => [e.source, e.reason])).toEqual([
      ["broken.md", "retry"],
      ["pending.md", "new"],
    ]);
    expect(retry.unchanged).toEqual(["ready.md"]);

    // Both are now pending with the same content and fresh: nothing new to enqueue.
    const again = await service.sync(tenantA);
    expect(again.enqueued).toEqual([]);
    expect(again.unchanged).toEqual(["broken.md", "pending.md", "ready.md"]);
    expect(queue.jobs.filter((j) => j.source === "pending.md")).toHaveLength(1);
  });

  it("re-enqueues a pending or processing document whose job was lost", async () => {
    const { knowledge, queue, service, clock, documents } = setUp();
    knowledge.set(tenantA, "lost.md", "Its job never ran.");
    await service.sync(tenantA);
    const lost = queue.jobs.splice(0)[0]!;
    await documents.setStatus(tenantA, lost.docId, { status: "processing", version: 1 });

    clock.advance(DEFAULT_STALE_AFTER_MS - 1);
    expect((await service.sync(tenantA)).unchanged).toEqual(["lost.md"]);

    clock.advance(1);
    const result = await service.sync(tenantA);
    expect(result.enqueued).toEqual([
      expect.objectContaining({ source: "lost.md", version: 2, reason: "stale" }),
    ]);
    expect(queue.jobs.map((j) => j.version)).toEqual([2]);
  });

  it("treats in-flight documents as stale at once with staleAfterMs 0 (CLI mode)", async () => {
    const deps = setUp();
    const cli = new IngestionService({ ...deps, clock: deps.clock }, { staleAfterMs: 0 });
    deps.knowledge.set(tenantA, "a.md", "Text.");
    await cli.sync(tenantA);
    expect((await cli.sync(tenantA)).enqueued.map((e) => e.reason)).toEqual(["stale"]);
  });

  it("enqueues a new version when the content changes", async () => {
    const { knowledge, queue, service, drain } = setUp();
    knowledge.set(tenantA, "a.md", "Version one.");
    await service.sync(tenantA);
    await drain();

    knowledge.set(tenantA, "a.md", "Version two.");
    const result = await service.sync(tenantA);

    expect(result.enqueued).toEqual([
      expect.objectContaining({ source: "a.md", version: 2, reason: "changed" }),
    ]);
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

  it("runs overlapping syncs of one tenant one after another", async () => {
    const { knowledge, queue, service } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");

    const [first, second] = await Promise.all([service.sync(tenantA), service.sync(tenantA)]);

    expect(first.enqueued.map((e) => e.source)).toEqual(["a.md"]);
    expect(second.unchanged).toEqual(["a.md"]);
    expect(queue.jobs).toHaveLength(1);
  });

  it("never deletes a document created by another process while it was listing files", async () => {
    const deps = setUp();
    deps.knowledge.set(tenantA, "a.md", "Text.");
    // The other process creates new.md after this sync read the documents but before it saw
    // the files; this sync's file list does not include new.md yet.
    const knowledge = {
      list: async (ctx: typeof tenantA) => {
        await deps.documents.upsertPending(ctx, { source: "new.md", contentHash: "h" });
        return deps.knowledge.list(ctx);
      },
      read: deps.knowledge.read.bind(deps.knowledge),
    };
    const service = new IngestionService({ ...deps, knowledge });

    const result = await service.sync(tenantA);

    expect(result.removed).toEqual([]);
    expect(await deps.documents.findBySource(tenantA, "new.md")).not.toBeNull();
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

  it("embeds in groups and refreshes the document between groups", async () => {
    const { knowledge, service, queue, handler, documents, embeddings, clock } = setUp();
    // 130 paragraphs of 50 characters: one chunk each at maxTokens 20 (80 characters).
    const text = Array.from({ length: 130 }, (_, i) =>
      `paragraph ${String(i).padStart(3, "0")} `.padEnd(50, "x"),
    ).join("\n\n");
    knowledge.set(tenantA, "long.md", text);
    await service.sync(tenantA);
    const updates: Date[] = [];
    const setStatus = documents.setStatus.bind(documents);
    documents.setStatus = async (ctx, id, update) => {
      clock.advance(1_000);
      await setStatus(ctx, id, update);
      updates.push((await documents.findBySource(tenantA, "long.md"))!.updatedAt);
    };

    await handler(queue.jobs[0]!, { attempt: 1, maxAttempts: 1 });

    expect(embeddings.calls.map((c) => c.length)).toEqual([64, 64, 2]);
    expect(updates).toHaveLength(4);
    expect(new Set(updates.map((d) => d.getTime())).size).toBe(4);
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

  it("marks a document without text ready with zero chunks, calls no embedding, and warns", async () => {
    const { knowledge, service, drain, documents, embeddings, logger } = setUp();
    knowledge.set(tenantA, "empty.md", "   \n\n  ");
    await service.sync(tenantA);
    await drain();
    expect(await documents.findBySource(tenantA, "empty.md")).toMatchObject({
      status: "ready",
      chunkCount: 0,
    });
    expect(embeddings.calls).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("no extractable text") as string,
      }),
    );
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

describe("superseded jobs", () => {
  it("does no work for a job whose version is no longer current", async () => {
    const { knowledge, service, queue, useCase, documents, chunks, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "One.");
    await service.sync(tenantA);
    const oldJob = queue.jobs.splice(0)[0]!;
    knowledge.set(tenantA, "a.md", "Two.");
    await service.sync(tenantA);

    await expect(useCase.execute(tenantA, oldJob)).resolves.toEqual({ status: "superseded" });

    expect(embeddings.calls).toEqual([]);
    expect(chunks.chunksOf(tenantA)).toEqual([]);
    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({ version: 2, status: "pending" });
  });

  it("does no work for a job whose docId does not belong to its source", async () => {
    const { knowledge, service, queue, useCase, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "A.").set(tenantA, "b.md", "B.");
    await service.sync(tenantA);
    const [a, b] = queue.jobs;
    const forged: IngestJob = { ...a!, docId: b!.docId };

    await expect(useCase.execute(tenantA, forged)).resolves.toEqual({ status: "superseded" });
    expect(embeddings.calls).toEqual([]);
  });

  it("writes no chunks when a newer version arrives while embedding", async () => {
    const deps = setUp();
    const fake = new FakeEmbeddingProvider({ dimensions: 4 });
    let bumped = false;
    const embeddings: EmbeddingProvider = {
      model: fake.model,
      dimensions: fake.dimensions,
      embed: async (texts) => {
        if (!bumped) {
          bumped = true;
          await deps.documents.upsertPending(tenantA, { source: "a.md", contentHash: "newer" });
        }
        return fake.embed(texts);
      },
    };
    const useCase = new IngestDocumentUseCase({ ...deps, parser: textParser, embeddings });
    deps.knowledge.set(tenantA, "a.md", "Text.");
    await deps.service.sync(tenantA);

    await expect(useCase.execute(tenantA, deps.queue.jobs[0]!)).resolves.toEqual({ status: "superseded" });
    expect(deps.chunks.chunksOf(tenantA)).toEqual([]);
  });

  it("removes its chunks when the document is deleted between writing and activating", async () => {
    const deps = setUp();
    const upsertMany = deps.chunks.upsertMany.bind(deps.chunks);
    deps.chunks.upsertMany = async (ctx, chunks) => {
      await upsertMany(ctx, chunks);
      await deps.documents.deleteBySource(ctx, "a.md");
    };
    deps.knowledge.set(tenantA, "a.md", "Text.");
    await deps.service.sync(tenantA);

    await expect(deps.useCase.execute(tenantA, deps.queue.jobs[0]!)).resolves.toEqual({
      status: "superseded",
    });
    expect(deps.chunks.chunksOf(tenantA)).toEqual([]);
  });
});

describe("ingest job handler", () => {
  it("keeps the document processing on a retryable failure and fails it on the last attempt", async () => {
    const { knowledge, service, queue, handler, documents, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    const job = queue.jobs[0]!;
    embeddings.failNext(new Error("provider down at 10.0.0.5"), 2);

    await expect(handler(job, { attempt: 1, maxAttempts: 2 })).rejects.toThrow("provider down");
    expect((await documents.findBySource(tenantA, "a.md"))?.status).toBe("processing");

    await expect(handler(job, { attempt: 2, maxAttempts: 2 })).rejects.toThrow("provider down");
    expect(await documents.findBySource(tenantA, "a.md")).toMatchObject({
      status: "failed",
      error: "Ingestion failed unexpectedly. See the worker logs for details.",
    });
  });

  it("stores the safe message of a provider error, never its details", async () => {
    const { knowledge, service, queue, handler, documents, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    embeddings.failNext(
      new ProviderError("Embedding request failed with HTTP 401 (key sk-...abcd)", { retryable: false }),
    );

    await expect(handler(queue.jobs[0]!, { attempt: 1, maxAttempts: 3 })).rejects.toBeInstanceOf(
      ProviderError,
    );

    const doc = await documents.findBySource(tenantA, "a.md");
    expect(doc).toMatchObject({
      status: "failed",
      error: "The AI provider is unavailable. Please try again.",
    });
  });

  it("treats a non-retryable provider error as final on the first attempt", async () => {
    const { knowledge, service, queue, handler, documents, embeddings } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    embeddings.failNext(new ProviderError("HTTP 404 model not found", { retryable: false }));

    await expect(handler(queue.jobs[0]!, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    expect((await documents.findBySource(tenantA, "a.md"))?.status).toBe("failed");
  });

  it("does not mark the document failed when the job is aborted by a shutdown", async () => {
    const { knowledge, service, queue, handler, documents } = setUp();
    knowledge.set(tenantA, "a.md", "Text.");
    await service.sync(tenantA);
    const controller = new AbortController();
    controller.abort(new Error("shutting down"));

    await expect(handler(queue.jobs[0]!, { attempt: 3, maxAttempts: 3 }, controller.signal)).rejects.toThrow(
      "shutting down",
    );
    expect((await documents.findBySource(tenantA, "a.md"))?.status).toBe("processing");
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

describe("documentErrorMessage", () => {
  it("keeps ingest messages and hides everything else", () => {
    expect(documentErrorMessage(new IngestError("a.md is broken", false))).toBe("a.md is broken");
    expect(documentErrorMessage(new ProviderError("HTTP 500 (internal detail)"))).toBe(
      "The AI provider is unavailable. Please try again.",
    );
    expect(documentErrorMessage(new Error("E11000 duplicate key ..."))).toBe(
      "Ingestion failed unexpectedly. See the worker logs for details.",
    );
  });
});
