import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the code. Integration and isolation suites get their own scripts later.
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/unit/**/*.test.ts",
      "packages/*/test/arch/**/*.test.ts",
      "examples/*/tools/**/*.test.ts",
    ],
    environment: "node",
    passWithNoTests: false,
  },
});
