import { createRequire } from "node:module";
import { cruise, type ICruiseResult, type IConfiguration } from "dependency-cruiser";
import { beforeAll, describe, expect, it } from "vitest";

// The same rules that `npm run arch` applies to packages/core/src, pointed at fixtures
// that break them on purpose. If a rule stops firing, this test fails.
const require = createRequire(import.meta.url);
const { makeConfig } = require("../../../../.dependency-cruiser.rules.cjs") as {
  makeConfig: (root: string) => IConfiguration;
};

const FIXTURE_ROOT = "packages/core/test/arch/fixtures/src";

interface Violation {
  rule: string;
  from: string;
  to: string;
}

let violations: Violation[] = [];

beforeAll(async () => {
  const config = makeConfig(`^${FIXTURE_ROOT}`);
  const { forbidden, options } = config;
  const result = await cruise([FIXTURE_ROOT], {
    ...options,
    ...(forbidden ? { ruleSet: { forbidden } } : {}),
    validate: true,
  });
  const output = result.output as ICruiseResult;
  violations = output.summary.violations.map((v) => ({
    rule: v.rule.name,
    from: v.from.replace(`${FIXTURE_ROOT}/`, ""),
    to: v.to.replace(`${FIXTURE_ROOT}/`, ""),
  }));
}, 30_000);

const rulesFor = (from: string): string[] =>
  violations
    .filter((v) => v.from === from)
    .map((v) => v.rule)
    .sort();

describe("architecture rules", () => {
  it("rejects domain importing infrastructure", () => {
    expect(rulesFor("domain/imports-infrastructure.ts")).toContain("domain-is-innermost");
  });

  it("rejects domain importing Node I/O modules", () => {
    expect(rulesFor("domain/uses-node-io.ts")).toEqual(["domain-no-node-io"]);
  });

  it("rejects application importing infrastructure", () => {
    expect(rulesFor("application/imports-infrastructure.ts")).toEqual(["application-depends-on-domain-only"]);
  });

  it("rejects application importing an adapter package such as mongodb", () => {
    expect(rulesFor("application/imports-mongodb.ts")).toContain("inner-layers-no-adapter-packages");
  });

  it("rejects interfaces importing infrastructure directly", () => {
    expect(rulesFor("interfaces/imports-infrastructure.ts")).toEqual(["interfaces-not-to-infrastructure"]);
  });

  it("allows application and infrastructure to depend on domain ports", () => {
    expect(rulesFor("application/uses-port.ts")).toEqual([]);
    expect(rulesFor("infrastructure/db.ts")).toEqual([]);
    expect(rulesFor("domain/ports.ts")).toEqual([]);
  });
});
