/**
 * Isolation property P3 (design.md section 8): a handler path that resolves outside its
 * tenant directory is rejected at load time, and the outside file is never imported.
 */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTenantDirectory, TenantConfigError } from "../../src/infrastructure/config/tenant-loader.js";
import { FIXTURES } from "../support/fixture-paths.js";

declare global {
  var __escapedHandlerImported: boolean | undefined;
}

async function handlerIssue(dir: string): Promise<string> {
  try {
    await loadTenantDirectory(dir);
  } catch (error) {
    if (error instanceof TenantConfigError) {
      const issue = error.tenantIssues.find((i) => i.path === "tools[0].handler");
      if (issue) return issue.reason;
    }
    throw error;
  }
  throw new Error("expected the tenant to be rejected");
}

/** A minimal tenant whose only tool points at `handler`. */
async function makeTenant(root: string, id: string, handler: string): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "tools"), { recursive: true });
  await writeFile(
    path.join(dir, "tenant.yaml"),
    [
      `id: ${id}`,
      "displayName: Escape test",
      "description: Handler path containment test.",
      "systemPrompt: Test.",
      "tools:",
      "  - name: escape",
      "    description: Points outside the tenant.",
      `    handler: ${handler}`,
      "    parameters: { type: object, properties: {} }",
    ].join("\n"),
  );
  return dir;
}

let root: string;
let outside: string;

beforeEach(async () => {
  globalThis.__escapedHandlerImported = undefined;
  root = await mkdtemp(path.join(tmpdir(), "tenants-"));
  outside = path.join(root, "..", `${path.basename(root)}-outside`);
  await mkdir(outside, { recursive: true });
  await cp(FIXTURES.escapedHandler, path.join(outside, "escaped-handler.js"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  expect(globalThis.__escapedHandlerImported).toBeUndefined();
});

describe("handler path containment (P3)", () => {
  it("rejects a handler path with '..' segments", async () => {
    expect(await handlerIssue(FIXTURES.invalid("escape-dotdot"))).toBe(
      "\"../../../outside/escaped-handler\" must not contain '..' segments",
    );
  });

  it("rejects an absolute handler path", async () => {
    expect(await handlerIssue(FIXTURES.invalid("escape-absolute"))).toBe(
      '"/etc/passwd" must be a relative path inside the tenant directory',
    );
  });

  it("rejects a handler file that is a symlink to a file outside the tenant", async () => {
    const dir = await makeTenant(root, "symlink-file", "./tools/escape");
    await symlink(path.join(outside, "escaped-handler.js"), path.join(dir, "tools", "escape.js"));

    expect(await handlerIssue(dir)).toBe('"./tools/escape" resolves outside the tenant directory');
  });

  it("rejects a handler inside a symlinked directory that points outside the tenant", async () => {
    const dir = await makeTenant(root, "symlink-dir", "./linked/escaped-handler");
    await symlink(outside, path.join(dir, "linked"), "dir");

    expect(await handlerIssue(dir)).toBe('"./linked/escaped-handler" resolves outside the tenant directory');
  });

  it("allows a symlink that stays inside the tenant directory", async () => {
    const dir = await makeTenant(root, "symlink-inside", "./tools/alias");
    await writeFile(path.join(dir, "tools", "real.js"), "export default async () => ({ ok: true });\n");
    await symlink(path.join(dir, "tools", "real.js"), path.join(dir, "tools", "alias.js"));

    const tenant = await loadTenantDirectory(dir);
    expect(tenant.config.tools[0]?.handlerPath).toBe(path.join(tenant.config.rootDir, "tools", "real.js"));
  });
});
