/**
 * Isolation property P3 (design.md section 8): a handler path that resolves outside its
 * tenant directory is rejected at load time, and the outside file is never imported.
 */
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTenantDirectory, TenantConfigError } from "../../src/infrastructure/config/tenant-loader.js";
import { FIXTURES } from "../support/fixture-paths.js";
import { OK_HANDLER, TempDirs, writeTenant } from "../support/temp-tenant.js";

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

const escapingTenant = (root: string, id: string, handler: string) =>
  writeTenant(root, id, [{ name: "escape", handler }]);

const temps = new TempDirs();
let root: string;
let outside: string;

beforeEach(async () => {
  globalThis.__escapedHandlerImported = undefined;
  root = await temps.make("tenants-");
  outside = await temps.make("outside-");
  await cp(FIXTURES.escapedHandler, path.join(outside, "escaped-handler.js"));
});

afterEach(async () => {
  await temps.cleanup();
  expect(globalThis.__escapedHandlerImported).toBeUndefined();
});

describe("handler path containment (P3)", () => {
  it("rejects a handler path with '..' segments", async () => {
    expect(await handlerIssue(FIXTURES.invalid("escape-dotdot"))).toBe(
      "\"../../../outside/escaped-handler\" must not contain '..' segments",
    );
  });

  it("rejects '..' segments written with Windows separators", async () => {
    const dir = await escapingTenant(root, "windows-dotdot", "tools\\..\\..\\outside");
    expect(await handlerIssue(dir)).toBe("\"tools\\..\\..\\outside\" must not contain '..' segments");
  });

  it("rejects absolute handler paths, POSIX and Windows style", async () => {
    expect(await handlerIssue(FIXTURES.invalid("escape-absolute"))).toBe(
      '"/etc/passwd" must be a relative path inside the tenant directory',
    );
    for (const [id, handler] of [
      ["windows-drive", "C:\\handlers\\escape.js"],
      ["windows-unc", "\\\\server\\share\\escape.js"],
    ] as const) {
      const dir = await escapingTenant(root, id, handler);
      expect(await handlerIssue(dir)).toBe(
        `"${handler}" must be a relative path inside the tenant directory`,
      );
    }
  });

  it("rejects a handler file that is a symlink to a file outside the tenant", async () => {
    const dir = await escapingTenant(root, "symlink-file", "./tools/escape");
    await symlink(path.join(outside, "escaped-handler.js"), path.join(dir, "tools", "escape.js"));

    expect(await handlerIssue(dir)).toBe('"./tools/escape" resolves outside the tenant directory');
  });

  it("rejects an extensionless symlink that points outside the tenant", async () => {
    const dir = await escapingTenant(root, "symlink-extensionless", "./tools/escape");
    await symlink(path.join(outside, "escaped-handler.js"), path.join(dir, "tools", "escape"));

    expect(await handlerIssue(dir)).toBe('"./tools/escape" resolves outside the tenant directory');
  });

  it("rejects a handler inside a symlinked directory that points outside the tenant", async () => {
    const dir = await escapingTenant(root, "symlink-dir", "./linked/escaped-handler");
    await symlink(outside, path.join(dir, "linked"), "dir");

    expect(await handlerIssue(dir)).toBe('"./linked/escaped-handler" resolves outside the tenant directory');
  });

  it("fails closed when an earlier candidate escapes, even if a later one is inside", async () => {
    const dir = await escapingTenant(root, "mixed-candidates", "./tools/escape");
    await symlink(path.join(outside, "escaped-handler.js"), path.join(dir, "tools", "escape.js"));
    await writeFile(path.join(dir, "tools", "escape.ts"), OK_HANDLER);

    expect(await handlerIssue(dir)).toBe('"./tools/escape" resolves outside the tenant directory');
  });

  it("allows a symlink that stays inside the tenant directory", async () => {
    const dir = await writeTenant(root, "symlink-inside", [{ name: "alias", handler: "./tools/alias" }]);
    await mkdir(path.join(dir, "tools"), { recursive: true });
    await writeFile(path.join(dir, "tools", "real.js"), OK_HANDLER);
    await symlink(path.join(dir, "tools", "real.js"), path.join(dir, "tools", "alias.js"));

    const tenant = await loadTenantDirectory(dir);
    expect(tenant.config.tools[0]?.handlerPath).toBe(path.join(tenant.config.rootDir, "tools", "real.js"));
  });
});
