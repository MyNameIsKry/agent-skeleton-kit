import { describe, expect, it } from "vitest";
import { FIXTURES } from "../test/support/fixture-paths.js";
import { main } from "./main.validate-tenant.js";

async function run(args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    env,
  });
  return { code, stdout, stderr };
}

describe("validate-tenant CLI", () => {
  it("validates the given directories without any API key in the environment", async () => {
    const result = await run([FIXTURES.alpha, FIXTURES.beta]);
    expect(result).toEqual({
      code: 0,
      stdout:
        "ok  fixture-alpha (1 tool: lookup_alpha)\n" +
        "ok  fixture-beta (1 tool: lookup_beta)\n" +
        "2 tenants valid.\n",
      stderr: "",
    });
  });

  it("validates every tenant in TENANTS_DIR when no directory is given", async () => {
    const result = await run([], { TENANTS_DIR: FIXTURES.validTenants });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 tenants valid.");
  });

  it("exits 1 and prints the field path and reason for an invalid tenant", async () => {
    const result = await run([FIXTURES.alpha, FIXTURES.invalid("id-mismatch")]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/id-mismatch: id: must equal the directory name "id-mismatch"/);
  });

  it("prints usage for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: validate-tenant/);
  });
});
