import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, DocumentNotFoundError } from "../../src/domain/errors.js";
import type { Message } from "../../src/domain/conversation.js";
import { MongoChunkRepository } from "../../src/infrastructure/mongo/chunk-repository.js";
import { chunksOf, documentsOf } from "../../src/infrastructure/mongo/collections.js";
import {
  MAX_STORED_MESSAGES,
  MongoConversationRepository,
} from "../../src/infrastructure/mongo/conversation-repository.js";
import { MongoDocumentRepository } from "../../src/infrastructure/mongo/document-repository.js";
import { ensureInfrastructure } from "../../src/infrastructure/mongo/ensure-infrastructure.js";
import { chunkId, documentId } from "../../src/infrastructure/mongo/ids.js";
import {
  DataStoreUsageError,
  MongoTenantDataStoreFactory,
} from "../../src/infrastructure/mongo/tenant-data-store.js";
import { newChunk } from "../support/chunks.js";
import { setUpTestMongo, TEST_DIMENSIONS, type TestMongo } from "../support/mongo.js";

let mongo: TestMongo;
let documents: MongoDocumentRepository;
let chunks: MongoChunkRepository;

beforeAll(async () => {
  mongo = await setUpTestMongo("repos");
  documents = new MongoDocumentRepository(mongo.store, mongo.clock);
  chunks = new MongoChunkRepository(mongo.store, mongo.clock, { dimensions: TEST_DIMENSIONS });
});
afterAll(() => mongo.drop());

const activeVersions = async (docId: string): Promise<number[]> => {
  const docs = await chunksOf(mongo.store).find({ docId, active: true }).toArray();
  return [...new Set(docs.map((d) => d.version))].sort();
};

describe("ensureInfrastructure", () => {
  it("is idempotent", async () => {
    await expect(ensureInfrastructure(mongo.store, { dimensions: TEST_DIMENSIONS })).resolves.toBeUndefined();
  });

  it("fails with a reindex instruction when the configured dimensions differ from the index", async () => {
    const error = await ensureInfrastructure(mongo.store, { dimensions: TEST_DIMENSIONS * 2 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(
      `has ${TEST_DIMENSIONS} dimensions, but EMBEDDING_DIMENSIONS is ${TEST_DIMENSIONS * 2}`,
    );
    expect((error as Error).message).toContain("reindex");
  });
});

describe("MongoDocumentRepository", () => {
  it("creates a pending document at version 1 with a deterministic id", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "create.md", contentHash: "h1" });
    expect(doc).toMatchObject({
      id: documentId("fixture-alpha", "create.md"),
      tenantId: "fixture-alpha",
      source: "create.md",
      contentHash: "h1",
      version: 1,
      activeVersion: null,
      status: "pending",
      chunkCount: 0,
    });
  });

  it("bumps the version atomically, so concurrent calls get distinct versions", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        documents.upsertPending(mongo.alpha, { source: "concurrent.md", contentHash: `h${i}` }),
      ),
    );
    expect(results.map((d) => d.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("records an error on failure and clears it on the next status", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "status.md", contentHash: "h" });
    await documents.setStatus(mongo.alpha, doc.id, { status: "failed", error: "parse error" });
    expect(await documents.findBySource(mongo.alpha, "status.md")).toMatchObject({
      status: "failed",
      error: "parse error",
    });

    await documents.setStatus(mongo.alpha, doc.id, { status: "processing" });
    const after = await documents.findBySource(mongo.alpha, "status.md");
    expect(after?.status).toBe("processing");
    expect(after).not.toHaveProperty("error");
  });

  it("keeps the same source separate per tenant", async () => {
    const a = await documents.upsertPending(mongo.alpha, { source: "shared.md", contentHash: "alpha" });
    const b = await documents.upsertPending(mongo.beta, { source: "shared.md", contentHash: "beta" });
    expect(a.id).not.toBe(b.id);
    expect((await documents.findBySource(mongo.alpha, "shared.md"))?.contentHash).toBe("alpha");
    expect((await documents.findBySource(mongo.beta, "shared.md"))?.contentHash).toBe("beta");
  });

  it("lists and deletes only the tenant's documents", async () => {
    await documents.upsertPending(mongo.beta, { source: "beta-only.md", contentHash: "b" });
    const alphaSources = (await documents.list(mongo.alpha)).map((d) => d.source);
    expect(alphaSources).not.toContain("beta-only.md");
    expect(alphaSources).toEqual([...alphaSources].sort());

    await documents.deleteBySource(mongo.alpha, "beta-only.md");
    expect(await documents.findBySource(mongo.beta, "beta-only.md")).not.toBeNull();
    await documents.deleteBySource(mongo.beta, "beta-only.md");
    expect(await documents.findBySource(mongo.beta, "beta-only.md")).toBeNull();
  });

  it("ignores a status update addressed to another tenant's document id", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "foreign-status.md", contentHash: "h" });
    await documents.setStatus(mongo.beta, doc.id, { status: "failed", error: "from beta" });
    expect((await documents.findBySource(mongo.alpha, "foreign-status.md"))?.status).toBe("pending");
  });
});

describe("MongoChunkRepository", () => {
  it("stores chunks under the context tenant, inactive, with deterministic ids (P5)", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "ids.md", contentHash: "h" });
    const input = [newChunk(doc.id, 1, 0, "zero"), newChunk(doc.id, 1, 1, "one")];

    await chunks.upsertMany(mongo.alpha, input);
    await chunks.upsertMany(mongo.alpha, input);

    const stored = await chunksOf(mongo.store).find({ docId: doc.id }).sort({ idx: 1 }).toArray();
    expect(stored.map((c) => c._id)).toEqual([chunkId(doc.id, 1, 0), chunkId(doc.id, 1, 1)]);
    expect(stored.every((c) => c.tenantId === "fixture-alpha" && !c.active)).toBe(true);
  });

  it("rejects embeddings of the wrong dimension", async () => {
    const bad = { ...newChunk("d", 1, 0, "x"), embedding: [1, 0] };
    await expect(chunks.upsertMany(mongo.alpha, [bad])).rejects.toThrow(/expected 4/);
  });

  it("activates exactly one version and marks the document ready (P6)", async () => {
    const v1 = await documents.upsertPending(mongo.alpha, { source: "swap.md", contentHash: "h1" });
    await chunks.upsertMany(mongo.alpha, [newChunk(v1.id, 1, 0, "v1-a"), newChunk(v1.id, 1, 1, "v1-b")]);
    await chunks.activateVersion(mongo.alpha, v1.id, 1);
    expect(await activeVersions(v1.id)).toEqual([1]);

    const v2 = await documents.upsertPending(mongo.alpha, { source: "swap.md", contentHash: "h2" });
    expect(v2.version).toBe(2);
    await chunks.upsertMany(mongo.alpha, [newChunk(v1.id, 2, 0, "v2-a")]);
    // Version 1 keeps serving while version 2 is being written.
    expect(await activeVersions(v1.id)).toEqual([1]);

    await chunks.activateVersion(mongo.alpha, v1.id, 2);
    expect(await activeVersions(v1.id)).toEqual([2]);
    expect(await documents.findBySource(mongo.alpha, "swap.md")).toMatchObject({
      status: "ready",
      activeVersion: 2,
      chunkCount: 1,
    });

    await chunks.deleteVersionsBefore(mongo.alpha, v1.id, 2);
    const remaining = await chunksOf(mongo.store).find({ docId: v1.id }).toArray();
    expect(remaining.map((c) => c.version)).toEqual([2]);
  });

  it("ignores a late activation of an older version", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "late.md", contentHash: "h1" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "v1")]);
    await documents.upsertPending(mongo.alpha, { source: "late.md", contentHash: "h2" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 2, 0, "v2")]);

    await chunks.activateVersion(mongo.alpha, doc.id, 2);
    await chunks.activateVersion(mongo.alpha, doc.id, 1);

    expect(await activeVersions(doc.id)).toEqual([2]);
    expect((await documents.findBySource(mongo.alpha, "late.md"))?.activeVersion).toBe(2);
  });

  it("keeps the document pending when a newer version is already in progress", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "in-progress.md", contentHash: "h1" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "v1")]);
    await documents.upsertPending(mongo.alpha, { source: "in-progress.md", contentHash: "h2" });

    await chunks.activateVersion(mongo.alpha, doc.id, 1);

    expect(await activeVersions(doc.id)).toEqual([1]);
    expect(await documents.findBySource(mongo.alpha, "in-progress.md")).toMatchObject({
      activeVersion: 1,
      version: 2,
      status: "pending",
    });
  });

  it("keeps active chunks active when a job for the active version is retried", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "retry.md", contentHash: "h" });
    const input = [newChunk(doc.id, 1, 0, "retry")];
    await chunks.upsertMany(mongo.alpha, input);
    await chunks.activateVersion(mongo.alpha, doc.id, 1);

    await chunks.upsertMany(mongo.alpha, input);

    expect(await activeVersions(doc.id)).toEqual([1]);
  });

  it("refuses to activate or delete another tenant's document", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "guarded.md", contentHash: "h" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "alpha only")]);

    await expect(chunks.activateVersion(mongo.beta, doc.id, 1)).rejects.toThrow(DocumentNotFoundError);
    await chunks.deleteByDocument(mongo.beta, doc.id);

    const stored = await chunksOf(mongo.store).find({ docId: doc.id }).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.active).toBe(false);
  });

  it("refuses to overwrite a chunk id that belongs to another tenant", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "owned.md", contentHash: "h" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "alpha text")]);

    await expect(chunks.upsertMany(mongo.beta, [newChunk(doc.id, 1, 0, "beta text")])).rejects.toThrow();

    const stored = await chunksOf(mongo.store).findOne({ _id: chunkId(doc.id, 1, 0) });
    expect(stored).toMatchObject({ tenantId: "fixture-alpha", text: "alpha text" });
  });

  it("deletes every chunk of a document", async () => {
    const doc = await documents.upsertPending(mongo.alpha, { source: "delete.md", contentHash: "h" });
    await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "a"), newChunk(doc.id, 2, 0, "b")]);
    await chunks.deleteByDocument(mongo.alpha, doc.id);
    expect(await chunksOf(mongo.store).countDocuments({ docId: doc.id })).toBe(0);
    expect(await documentsOf(mongo.store).countDocuments({ _id: doc.id })).toBe(1);
  });
});

describe("MongoConversationRepository", () => {
  const conversations = () => new MongoConversationRepository(mongo.store, mongo.clock);
  const user = (content: string): Message => ({ role: "user", content });

  it("returns the most recent messages in order", async () => {
    await conversations().append(mongo.alpha, "s-order", [user("1"), user("2")]);
    await conversations().append(mongo.alpha, "s-order", [user("3")]);
    expect(await conversations().recent(mongo.alpha, "s-order", 2)).toEqual([user("2"), user("3")]);
  });

  it("keeps at most MAX_STORED_MESSAGES per session", async () => {
    const many = Array.from({ length: MAX_STORED_MESSAGES + 5 }, (_, i) => user(String(i)));
    await conversations().append(mongo.alpha, "s-cap", many);
    const stored = await conversations().recent(mongo.alpha, "s-cap", MAX_STORED_MESSAGES + 5);
    expect(stored).toHaveLength(MAX_STORED_MESSAGES);
    expect(stored[0]).toEqual(user("5"));
  });

  it("returns nothing for an unknown session", async () => {
    expect(await conversations().recent(mongo.alpha, "s-unknown", 10)).toEqual([]);
  });
});

describe("MongoTenantDataStore", () => {
  const stores = () => new MongoTenantDataStoreFactory(mongo.store, mongo.clock);

  it("inserts, finds, and updates records by data fields", async () => {
    const data = stores().forTenant(mongo.alpha);
    const { id } = await data.insert("tickets", { ticketId: "IT-1", status: "open", priority: "high" });
    await data.insert("tickets", { ticketId: "IT-2", status: "open", priority: "low" });
    expect(id).toMatch(/^[0-9a-f]{24}$/);

    expect(await data.findOne("tickets", { ticketId: "IT-1" })).toEqual({
      ticketId: "IT-1",
      status: "open",
      priority: "high",
    });
    expect((await data.find("tickets", { status: "open" })).map((r) => r.ticketId)).toEqual(["IT-1", "IT-2"]);
    expect(await data.find("tickets", {}, 1)).toHaveLength(1);

    expect(await data.update("tickets", { ticketId: "IT-2" }, { status: "closed" })).toBe(1);
    expect(await data.findOne("tickets", { ticketId: "IT-2" })).toMatchObject({ status: "closed" });
  });

  it("rejects operator and dotted keys and invalid collection names", async () => {
    const data = stores().forTenant(mongo.alpha);
    await expect(data.find("tickets", { $where: "true" })).rejects.toThrow(DataStoreUsageError);
    await expect(data.find("tickets", { "a.b": 1 })).rejects.toThrow(DataStoreUsageError);
    await expect(data.update("tickets", {}, { $set: { x: 1 } })).rejects.toThrow(DataStoreUsageError);
    await expect(data.insert("tickets", { "x.y": 1 })).rejects.toThrow(DataStoreUsageError);
    await expect(data.insert("Bad Name", {})).rejects.toThrow(DataStoreUsageError);
  });
});
