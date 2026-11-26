/**
 * ingest: syncs tenants' knowledge into MongoDB, processing every job in-process (no Redis or
 * worker needed). Exits 1 if any document fails.
 *
 *   npm run ingest -- --tenant ops-onboarding-copilot
 *   npm run ingest -- --all
 *
 * Needs MONGODB_URI and the embedding settings from .env. On the host, point MONGODB_URI at
 * the port published by docker-compose.test.yml, for example
 * mongodb://127.0.0.1:27017/agent_skeleton?directConnection=true.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createIngestJobHandler, IngestDocumentUseCase } from "./application/ingestion/ingest-document.js";
import { IngestionService } from "./application/ingestion/ingestion-service.js";
import { InMemoryTenantRegistry } from "./application/tenants/in-memory-tenant-registry.js";
import { AppError, ConfigurationError, TenantNotFoundError } from "./domain/errors.js";
import type { EmbeddingProvider, LogFields, Logger } from "./domain/ports.js";
import type { TenantContext } from "./domain/tenant.js";
import { systemClock } from "./infrastructure/clock.js";
import { loadEnv, type EnvSource } from "./infrastructure/config/env.js";
import { loadTenants } from "./infrastructure/config/tenant-loader.js";
import { OpenAiCompatibleEmbeddings } from "./infrastructure/embeddings/openai-compatible-embeddings.js";
import { FsKnowledgeSource } from "./infrastructure/knowledge/fs-knowledge-source.js";
import { MongoChunkRepository } from "./infrastructure/mongo/chunk-repository.js";
import { connectMongo } from "./infrastructure/mongo/client.js";
import { MongoDocumentRepository } from "./infrastructure/mongo/document-repository.js";
import { ensureInfrastructure } from "./infrastructure/mongo/ensure-infrastructure.js";
import { ExtensionDocumentParser } from "./infrastructure/parsers/document-parser.js";
import { InlineJobQueue } from "./infrastructure/queue/inline-job-queue.js";

export interface IngestCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: EnvSource;
  /** Tests replace the provider so no network call is made. */
  embeddings?: EmbeddingProvider;
}

const USAGE = "Usage: ingest (--tenant <id> [--tenant <id> ...] | --all) [--verbose]\n";

type Args = { help: true } | { help: false; tenants: string[] | "all"; verbose: boolean };

function parseArgs(args: readonly string[]): Args | string {
  const tenants: string[] = [];
  let all = false;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--all") all = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--tenant") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return "--tenant needs a tenant id";
      tenants.push(value);
    } else return `Unknown argument "${String(arg)}"`;
  }
  if (all && tenants.length > 0) return "Use either --all or --tenant, not both";
  if (!all && tenants.length === 0) return "Choose tenants with --tenant <id> or --all";
  return { help: false, tenants: all ? "all" : tenants, verbose };
}

/** One line per log entry on stderr: warnings and errors always, the rest with --verbose. */
function cliLogger(write: (text: string) => void, verbose: boolean, bindings: LogFields = {}): Logger {
  const emit = (level: string, show: boolean) => (fields: LogFields, message: string) => {
    if (!show) return;
    const merged = { ...bindings, ...fields };
    const details = Object.keys(merged).length === 0 ? "" : ` ${JSON.stringify(merged)}`;
    write(`${level} ${message}${details}\n`);
  };
  return {
    debug: emit("debug", verbose),
    info: emit("info", verbose),
    warn: emit("warn", true),
    error: emit("error", true),
    child: (more) => cliLogger(write, verbose, { ...bindings, ...more }),
  };
}

/** Returns the process exit code. */
export async function main(args: readonly string[], io: IngestCliIo): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") {
    io.stderr(`${parsed}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  const logger = cliLogger(io.stderr, parsed.verbose);

  let store: Awaited<ReturnType<typeof connectMongo>> | undefined;
  try {
    const env = loadEnv(["tenants", "infrastructure", "providers"], io.env);
    const registry = new InMemoryTenantRegistry(
      (await loadTenants(path.resolve(env.tenants.tenantsDir), { logger })).map((t) => t.config),
    );
    const contexts: TenantContext[] =
      parsed.tenants === "all"
        ? registry.list().map((t) => registry.resolve(t.id))
        : parsed.tenants.map((id) => registry.resolve(id));

    const embeddings =
      io.embeddings ??
      new OpenAiCompatibleEmbeddings({
        ...env.providers.embedding,
        logger,
      });

    store = await connectMongo(env.infrastructure.mongodbUri, { appName: "agent-skeleton-ingest" });
    await ensureInfrastructure(store, { dimensions: embeddings.dimensions, logger });

    const documents = new MongoDocumentRepository(store, systemClock);
    const chunks = new MongoChunkRepository(store, systemClock, { dimensions: embeddings.dimensions });
    const knowledge = new FsKnowledgeSource({ logger });
    const queue = new InlineJobQueue();
    const useCase = new IngestDocumentUseCase({
      knowledge,
      parser: new ExtensionDocumentParser(),
      embeddings,
      documents,
      chunks,
      logger,
    });
    queue.process(createIngestJobHandler({ registry, useCase, documents, logger }));
    const service = new IngestionService({ knowledge, documents, chunks, queue, logger });

    let failed = 0;
    for (const ctx of contexts) {
      const before = queue.results.length;
      const result = await service.sync(ctx);
      const outcomes = queue.results.slice(before);
      io.stdout(`${ctx.tenantId}\n`);
      for (const outcome of outcomes) {
        io.stdout(
          outcome.ok
            ? `  ingested   ${outcome.source}\n`
            : `  FAILED     ${outcome.source}: ${outcome.error ?? ""}\n`,
        );
        if (!outcome.ok) failed++;
      }
      for (const source of result.unchanged) io.stdout(`  unchanged  ${source}\n`);
      for (const source of result.removed) io.stdout(`  removed    ${source}\n`);
      if (outcomes.length + result.unchanged.length + result.removed.length === 0) {
        io.stdout("  no knowledge files\n");
      }
    }
    io.stdout(failed === 0 ? "Done.\n" : `${failed} document${failed === 1 ? "" : "s"} failed.\n`);
    return failed === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof TenantNotFoundError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof AppError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await store?.client.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
