import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../../../test/support/fixture-paths.js";
import { recordingLogger, sha256 } from "../../../test/support/ingestion.js";
import { TempDirs } from "../../../test/support/temp-tenant.js";
import { InMemoryTenantRegistry } from "../../application/tenants/in-memory-tenant-registry.js";
import { IngestError } from "../../domain/errors.js";
import type { TenantContext } from "../../domain/tenant.js";
import { loadTenants } from "../config/tenant-loader.js";
import { FsKnowledgeSource } from "./fs-knowledge-source.js";

const temps = new TempDirs();
let alpha: TenantContext;
let knowledge: string;

beforeEach(async () => {
  const root = await temps.make("tenants-");
  await cp(FIXTURES.validTenants, root, { recursive: true });
  const registry = new InMemoryTenantRegistry((await loadTenants(root)).map((t) => t.config));
  alpha = registry.resolve("fixture-alpha");
  knowledge = path.join(alpha.config.rootDir, "knowledge");
});
afterEach(() => temps.cleanup());

describe("FsKnowledgeSource", () => {
  it("lists supported files with their content hash, skipping hidden and unsupported files", async () => {
    await writeFile(path.join(knowledge, "notes.txt"), "plain text");
    await writeFile(path.join(knowledge, ".draft.md"), "hidden");
    const logger = recordingLogger();

    const files = await new FsKnowledgeSource({ logger }).list(alpha);

    expect(files.map((f) => f.source)).toEqual(["alpha-handbook.md", "onboarding-checklist.pdf"]);
    const handbook = await new FsKnowledgeSource().read(alpha, "alpha-handbook.md");
    expect(files[0]?.contentHash).toBe(handbook.contentHash);
    expect(logger.entries.map((e) => [e.message, e.fields.source])).toEqual([
      ["Skipping unsupported knowledge file type", "notes.txt"],
    ]);
  });

  it("skips files above the size limit when listing and rejects them when reading", async () => {
    await writeFile(path.join(knowledge, "big.md"), "x".repeat(101));
    const source = new FsKnowledgeSource({ maxFileBytes: 100 });
    expect((await source.list(alpha)).map((f) => f.source)).not.toContain("big.md");
    await expect(source.read(alpha, "big.md")).rejects.toThrow("big.md is larger than 100 bytes");
  });

  it("returns the bytes and their sha256", async () => {
    await writeFile(path.join(knowledge, "new.md"), "Hello");
    const file = await new FsKnowledgeSource().read(alpha, "new.md");
    expect(new TextDecoder().decode(file.bytes)).toBe("Hello");
    expect(file.contentHash).toBe(sha256("Hello"));
  });

  it("reports a missing file as a non-retryable error", async () => {
    const error = await new FsKnowledgeSource().read(alpha, "gone.md").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).message).toBe("gone.md no longer exists");
    expect((error as IngestError).retryable).toBe(false);
  });

  it("lists nothing for a tenant without a knowledge directory", async () => {
    const source = new FsKnowledgeSource();
    const ctx = { ...alpha, config: { ...alpha.config, rootDir: path.join(alpha.config.rootDir, "nope") } };
    expect(await source.list(ctx)).toEqual([]);
  });
});
