/**
 * Idempotent startup step run by every process that uses Mongo: create regular indexes,
 * create the vector index if absent, check its dimensions, and wait until it is queryable.
 */
import { MongoServerError } from "mongodb";
import { ConfigurationError, InfrastructureUnavailableError } from "../../domain/errors.js";
import type { Logger } from "../../domain/ports.js";
import {
  chunksOf,
  conversationsOf,
  documentsOf,
  toolRecordsOf,
  VECTOR_INDEX_NAME,
  type MongoStore,
} from "./collections.js";

export const CONVERSATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface EnsureInfrastructureOptions {
  dimensions: number;
  logger?: Logger;
  /** How long to wait for the vector index to become queryable. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface SearchIndexInfo {
  name: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: { fields?: { type?: string; path?: string; numDimensions?: number }[] };
}

export function vectorIndexDefinition(dimensions: number) {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
      { type: "filter", path: "tenantId" },
      { type: "filter", path: "active" },
    ],
  };
}

const REINDEX_HELP =
  "To change embedding dimensions, reindex: stop the stack, run `docker compose down -v` " +
  "(this deletes all stored data), and start again. Knowledge is re-ingested on startup.";

async function ensureRegularIndexes(store: MongoStore): Promise<void> {
  await Promise.all([
    documentsOf(store).createIndex(
      { tenantId: 1, source: 1 },
      { unique: true, name: "tenant_source" },
      undefined,
    ),
    chunksOf(store).createIndex(
      { tenantId: 1, docId: 1, version: 1 },
      { name: "tenant_doc_version" },
      undefined,
    ),
    conversationsOf(store).createIndex(
      { tenantId: 1, sessionId: 1 },
      { unique: true, name: "tenant_session" },
      undefined,
    ),
    conversationsOf(store).createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: CONVERSATION_TTL_SECONDS, name: "ttl_updated_at" },
      undefined,
    ),
    toolRecordsOf(store).createIndex(
      { tenantId: 1, collection: 1, createdAt: 1 },
      { name: "tenant_collection_created" },
      undefined,
    ),
  ]);
}

async function findVectorIndex(store: MongoStore): Promise<SearchIndexInfo | undefined> {
  const indexes = (await chunksOf(store).listSearchIndexes(VECTOR_INDEX_NAME).toArray()) as SearchIndexInfo[];
  return indexes[0];
}

function checkDefinition(index: SearchIndexInfo, dimensions: number): void {
  const fields = index.latestDefinition?.fields ?? [];
  const vector = fields.find((f) => f.type === "vector" && f.path === "embedding");
  const issues: string[] = [];
  if (vector?.numDimensions !== dimensions) {
    issues.push(
      `vector index "${VECTOR_INDEX_NAME}" has ${String(vector?.numDimensions ?? "no")} dimensions, ` +
        `but EMBEDDING_DIMENSIONS is ${dimensions}`,
    );
  }
  for (const path of ["tenantId", "active"]) {
    if (!fields.some((f) => f.type === "filter" && f.path === path)) {
      issues.push(`vector index "${VECTOR_INDEX_NAME}" has no filter field "${path}"`);
    }
  }
  if (issues.length > 0) {
    throw new ConfigurationError("The vector index does not match the configuration:", issues, REINDEX_HELP);
  }
}

async function createVectorIndex(store: MongoStore, dimensions: number): Promise<void> {
  try {
    await chunksOf(store).createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition: vectorIndexDefinition(dimensions),
    });
  } catch (error) {
    // The API and the worker start together; the other process may have created it first.
    const duplicate = error instanceof MongoServerError && /already exists|duplicate/i.test(error.message);
    if (!duplicate) throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureInfrastructure(
  store: MongoStore,
  options: EnsureInfrastructureOptions,
): Promise<void> {
  const { dimensions, logger } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  await ensureRegularIndexes(store);

  let index = await findVectorIndex(store);
  if (index === undefined) {
    logger?.info({ index: VECTOR_INDEX_NAME, dimensions }, "Creating vector index");
    await createVectorIndex(store, dimensions);
    index = await findVectorIndex(store);
  }
  if (index === undefined) {
    throw new InfrastructureUnavailableError(`Vector index "${VECTOR_INDEX_NAME}" was not created`);
  }
  checkDefinition(index, dimensions);

  const deadline = Date.now() + timeoutMs;
  while (index.queryable !== true) {
    if (index.status === "FAILED") {
      throw new InfrastructureUnavailableError(`Vector index "${VECTOR_INDEX_NAME}" failed to build`);
    }
    if (Date.now() >= deadline) {
      throw new InfrastructureUnavailableError(
        `Vector index "${VECTOR_INDEX_NAME}" was not queryable after ${timeoutMs} ms (status ${index.status ?? "unknown"})`,
      );
    }
    logger?.debug({ index: VECTOR_INDEX_NAME, status: index.status }, "Waiting for vector index");
    await sleep(pollIntervalMs);
    index = (await findVectorIndex(store)) ?? index;
  }
  logger?.info({ index: VECTOR_INDEX_NAME, dimensions }, "Vector index is queryable");
}
