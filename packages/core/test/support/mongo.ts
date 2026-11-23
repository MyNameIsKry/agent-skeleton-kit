/**
 * Shared setup for tests that need a real MongoDB (atlas-local). Each call gets a fresh,
 * uniquely named database that `drop()` removes. Tests never skip when Mongo is down; they
 * fail with instructions instead.
 */
import { randomUUID } from "node:crypto";
import { InMemoryTenantRegistry } from "../../src/application/tenants/in-memory-tenant-registry.js";
import type { Clock } from "../../src/domain/ports.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import { loadTenants } from "../../src/infrastructure/config/tenant-loader.js";
import { connectMongo } from "../../src/infrastructure/mongo/client.js";
import type { MongoStore } from "../../src/infrastructure/mongo/collections.js";
import { ensureInfrastructure } from "../../src/infrastructure/mongo/ensure-infrastructure.js";
import { FIXTURES } from "./fixture-paths.js";

export const TEST_DIMENSIONS = 4;

const DEFAULT_TEST_URI = "mongodb://127.0.0.1:27017/?directConnection=true";

const HOW_TO_START =
  "Start it with: docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --wait mongo " +
  "(or set MONGODB_URI).";

export interface TestMongo {
  store: MongoStore;
  alpha: TenantContext;
  beta: TenantContext;
  clock: Clock;
  drop(): Promise<void>;
}

/** Connects, creates indexes and the vector index in a new database, and resolves the fixture tenants. */
export async function setUpTestMongo(prefix: string): Promise<TestMongo> {
  const uri = process.env.MONGODB_URI ?? DEFAULT_TEST_URI;
  const databaseName = `test_${prefix}_${randomUUID().slice(0, 8)}`;

  let store: MongoStore;
  try {
    store = await connectMongo(uri, {
      appName: "agent-skeleton-tests",
      databaseName,
      serverSelectionTimeoutMS: 5_000,
    });
  } catch (error) {
    throw new Error(`These tests need MongoDB at ${uri}. ${HOW_TO_START}`, { cause: error });
  }

  await ensureInfrastructure(store, { dimensions: TEST_DIMENSIONS, timeoutMs: 90_000, pollIntervalMs: 500 });

  const registry = new InMemoryTenantRegistry(
    (await loadTenants(FIXTURES.validTenants)).map((t) => t.config),
  );

  return {
    store,
    alpha: registry.resolve("fixture-alpha"),
    beta: registry.resolve("fixture-beta"),
    clock: { now: () => new Date() },
    async drop() {
      await store.db.dropDatabase();
      await store.client.close();
    },
  };
}

/**
 * Polls until `check` returns true. The vector index is eventually consistent, so tests wait
 * for it to catch up before asserting what a search does or does not return.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A unit vector along `axis`, so cosine scores are exact and easy to reason about. */
export const axis = (index: number): number[] =>
  Array.from({ length: TEST_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
