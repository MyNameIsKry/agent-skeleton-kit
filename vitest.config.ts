import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          // Fast tests: no network, no Docker, no real LLM.
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/unit/**/*.test.ts",
            "packages/*/test/arch/**/*.test.ts",
            "examples/*/tools/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          // Tenant isolation invariants (.kiro/steering/tenant-isolation.md). Never skip.
          name: "isolation",
          include: ["packages/*/test/isolation/**/*.test.ts"],
        },
      },
    ],
  },
});
