/**
 * Isolation: an ingestion job's `source` travels through Redis and is untrusted. Reading it
 * must never reach a file outside the tenant's own `knowledge/` directory (tenant-isolation
 * rules 5 and 7), and listing must not follow symlinks out of it.
 */
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTenantRegistry } from "../../src/application/tenants/in-memory-tenant-registry.js";
import { IngestError } from "../../src/domain/errors.js";
import type { TenantContext } from "../../src/domain/tenant.js";
import { loadTenants } from "../../src/infrastructure/config/tenant-loader.js";
import { FsKnowledgeSource } from "../../src/infrastructure/knowledge/fs-knowledge-source.js";
import { FIXTURES } from "../support/fixture-paths.js";
import { recordingLogger } from "../support/ingestion.js";
import { TempDirs } from "../support/temp-tenant.js";

const temps = new TempDirs();
let alpha: TenantContext;
let beta: TenantContext;
let root: string;

beforeEach(async () => {
  root = await temps.make("tenants-");
  await cp(FIXTURES.validTenants, root, { recursive: true });
  const registry = new InMemoryTenantRegistry((await loadTenants(root)).map((t) => t.config));
  alpha = registry.resolve("fixture-alpha");
  beta = registry.resolve("fixture-beta");
});
afterEach(() => temps.cleanup());

async function readError(ctx: TenantContext, source: string): Promise<IngestError> {
  const error = await new FsKnowledgeSource().read(ctx, source).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestError);
  expect((error as IngestError).retryable).toBe(false);
  return error as IngestError;
}

describe("knowledge source containment", () => {
  it.each([
    ["the tenant config next to knowledge/", "../tenant.yaml"],
    ["another tenant's knowledge", "../../fixture-beta/knowledge/beta-guide.md"],
    ["a path with a dot segment", "./alpha-handbook.md"],
    ["a POSIX absolute path", "/etc/hosts.md"],
    ["a Windows path", "..\\..\\fixture-beta\\knowledge\\beta-guide.md"],
    ["a NUL byte", "alpha-handbook.md\u0000.md"],
  ])("refuses to read %s", async (_label, source) => {
    await readError(alpha, source);
  });

  it("refuses to read through a symlink that points into another tenant", async () => {
    await symlink(
      path.join(beta.config.rootDir, "knowledge", "beta-guide.md"),
      path.join(alpha.config.rootDir, "knowledge", "stolen.md"),
    );
    const error = await readError(alpha, "stolen.md");
    expect(error.message).toBe("stolen.md resolves outside knowledge/");
  });

  it("refuses to read through a directory symlink that leaves knowledge/", async () => {
    await symlink(
      path.join(beta.config.rootDir, "knowledge"),
      path.join(alpha.config.rootDir, "knowledge", "shared"),
      "dir",
    );
    const error = await readError(alpha, "shared/beta-guide.md");
    expect(error.message).toBe("shared/beta-guide.md resolves outside knowledge/");
  });

  it("does not list files reached through a symlink that leaves knowledge/", async () => {
    await symlink(
      path.join(beta.config.rootDir, "knowledge"),
      path.join(alpha.config.rootDir, "knowledge", "beta"),
      "dir",
    );
    const logger = recordingLogger();

    const sources = (await new FsKnowledgeSource({ logger }).list(alpha)).map((f) => f.source);

    expect(sources).toEqual(["alpha-handbook.md", "onboarding-checklist.pdf"]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Skipping knowledge path that resolves outside knowledge/",
      }),
    );
  });

  it("reads the tenant's own files, including nested ones and in-directory symlinks", async () => {
    const knowledge = path.join(alpha.config.rootDir, "knowledge");
    await mkdir(path.join(knowledge, "policies"));
    await writeFile(path.join(knowledge, "policies", "leave.md"), "# Leave\nTake it.");
    await symlink(path.join(knowledge, "alpha-handbook.md"), path.join(knowledge, "handbook-alias.md"));
    const source = new FsKnowledgeSource();

    expect((await source.list(alpha)).map((f) => f.source)).toEqual([
      "alpha-handbook.md",
      "handbook-alias.md",
      "onboarding-checklist.pdf",
      "policies/leave.md",
    ]);
    const file = await source.read(alpha, "policies/leave.md");
    expect(new TextDecoder().decode(file.bytes)).toBe("# Leave\nTake it.");
  });
});
