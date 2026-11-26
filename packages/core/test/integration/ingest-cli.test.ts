/**
 * End to end: the `ingest` CLI against real MongoDB with fake embeddings, over a copy of the
 * fixture tenants, then a vector search for each tenant's canary.
 */
import { randomUUID } from "node:crypto";
import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTenantRegistry } from "../../src/application/tenants/in-memory-tenant-registry.js";
import type { Logger } from "../../src/domain/ports.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import { loadTenants } from "../../src/infrastructure/config/tenant-loader.js";
import { connectMongo } from "../../src/infrastructure/mongo/client.js";
import { chunksOf, type MongoStore } from "../../src/infrastructure/mongo/collections.js";
import { MongoDocumentRepository } from "../../src/infrastructure/mongo/document-repository.js";
import { MongoVectorSearch } from "../../src/infrastructure/mongo/vector-search.js";
import { main } from "../../src/main.ingest.js";
import { FakeEmbeddingProvider } from "../../src/testing.js";
import { FIXTURES } from "../support/fixture-paths.js";
import { waitFor } from "../support/mongo.js";
import { TempDirs } from "../support/temp-tenant.js";

const DIMENSIONS = 8;
const databaseName = `test_cli_${randomUUID().slice(0, 8)}`;
const mongoUri = `mongodb://127.0.0.1:27017/${databaseName}?directConnection=true`;

const temps = new TempDirs();
const embeddings = new FakeEmbeddingProvider({ dimensions: DIMENSIONS });
let tenantsDir: string;
let store: MongoStore;
let alpha: TenantContext;
let beta: TenantContext;

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    embeddings,
    env: {
      TENANTS_DIR: tenantsDir,
      MONGODB_URI: process.env.MONGODB_URI_CLI ?? mongoUri,
      REDIS_URL: "redis://127.0.0.1:6379",
      LLM_API_KEY: "unused-in-this-test",
      LLM_MODEL: "unused",
      EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    },
  });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  tenantsDir = await temps.make("tenants-");
  await cp(FIXTURES.validTenants, tenantsDir, { recursive: true });
  store = await connectMongo(mongoUri, { appName: "ingest-cli-test", serverSelectionTimeoutMS: 5_000 });
  const registry = new InMemoryTenantRegistry((await loadTenants(tenantsDir)).map((t) => t.config));
  alpha = registry.resolve("fixture-alpha");
  beta = registry.resolve("fixture-beta");
});

afterAll(async () => {
  await store.db.dropDatabase();
  await store.client.close();
  await temps.cleanup();
});

describe("ingest CLI", () => {
  it("ingests every tenant's Markdown and PDF knowledge", async () => {
    const result = await run(["--all"]);
    expect(result.code).toBe(0);
    // The fixtures include a directory without tenant.yaml; it is skipped with a warning.
    expect(result.stderr).toMatch(/^warn Skipping directory without a tenant config file .*not-a-tenant/);
    expect(result.stdout).toBe(
      [
        "fixture-alpha",
        "  ingested   alpha-handbook.md",
        "  ingested   onboarding-checklist.pdf",
        "fixture-beta",
        "  ingested   beta-guide.md",
        "Done.",
        "",
      ].join("\n"),
    );

    const documents = new MongoDocumentRepository(store, { now: () => new Date() });
    const pdf = await documents.findBySource(alpha, "onboarding-checklist.pdf");
    expect(pdf).toMatchObject({ status: "ready", activeVersion: 1, chunkCount: 2 });
    const pages = await chunksOf(store).find({ docId: pdf!.id }).sort({ idx: 1 }).toArray();
    expect(pages.map((c) => c.meta)).toEqual([{ page: 1 }, { page: 2 }]);
  });

  it("finds each tenant's canary only for that tenant", async () => {
    const search = new MongoVectorSearch(store, {
      dimensions: DIMENSIONS,
      logger: { error: () => undefined } as unknown as Logger,
    });
    const handbook = await chunksOf(store).findOne({
      tenantId: "fixture-alpha",
      source: "alpha-handbook.md",
    });
    expect(handbook?.text).toContain("violet-otter-42");
    const query = handbook?.embedding ?? [];

    await waitFor(
      async () => (await search.search(alpha, query, { topK: 5, minScore: 0.99 })).length > 0,
      "alpha chunks to be searchable",
    );
    const forAlpha = await search.search(alpha, query, { topK: 5, minScore: 0.99 });
    const forBeta = await search.search(beta, query, { topK: 5, minScore: -1 });

    expect(forAlpha.map((r) => r.source)).toEqual(["alpha-handbook.md"]);
    expect(forBeta.every((r) => r.tenantId === "fixture-beta")).toBe(true);
    expect(JSON.stringify(forBeta)).not.toContain("violet-otter-42");
  });

  it("skips unchanged files, re-ingests changed ones, and removes deleted ones", async () => {
    const knowledge = path.join(alpha.config.rootDir, "knowledge");
    await writeFile(
      path.join(knowledge, "alpha-handbook.md"),
      "# Alpha handbook\n\n## Updated\n\nNew policy text.\n",
    );
    await rm(path.join(knowledge, "onboarding-checklist.pdf"));

    const result = await run(["--tenant", "fixture-alpha"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "fixture-alpha",
        "  ingested   alpha-handbook.md",
        "  removed    onboarding-checklist.pdf",
        "Done.",
        "",
      ].join("\n"),
    );
    const chunks = await chunksOf(store).find({ tenantId: "fixture-alpha" }).toArray();
    expect(chunks.map((c) => [c.source, c.version, c.active, c.meta])).toEqual([
      ["alpha-handbook.md", 2, true, { headingPath: ["Alpha handbook", "Updated"] }],
    ]);

    expect((await run(["--tenant", "fixture-alpha"])).stdout).toBe(
      ["fixture-alpha", "  unchanged  alpha-handbook.md", "Done.", ""].join("\n"),
    );
  });

  it("reports a failed document and exits 1", async () => {
    await writeFile(path.join(beta.config.rootDir, "knowledge", "broken.pdf"), "not a pdf");
    const result = await run(["--tenant", "fixture-beta"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("  FAILED     broken.pdf: broken.pdf is not a readable PDF\n");
    expect(result.stdout).toContain("1 document failed.");
  });

  it("rejects an unknown tenant and bad arguments", async () => {
    const unknown = await run(["--tenant", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown tenant: "nope"\n$/);
    expect((await run([])).code).toBe(2);
    expect((await run(["--all", "--tenant", "fixture-alpha"])).code).toBe(2);
  });
});
