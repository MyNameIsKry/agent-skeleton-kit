// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const NO_DEFAULT_EXPORT_IN_CORE = {
  selector: "ExportDefaultDeclaration",
  message: "Use named exports in core.",
};

const TENANT_CONTEXT_CAST_MESSAGE =
  "Do not cast to TenantContext. Get one from TenantRegistry.resolve (tenant-isolation rule 1).";
const NO_TENANT_CONTEXT_CASTS = ["TSAsExpression", "TSTypeAssertion"].map((node) => ({
  selector: `${node} > TSTypeReference.typeAnnotation > Identifier.typeName[name='TenantContext']`,
  message: TENANT_CONTEXT_CAST_MESSAGE,
}));

export default tseslint.config(
  {
    ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "**/test/**/fixtures/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          // Root-level JS config files are not part of any tsconfig.
          allowDefaultProject: ["*.js", ".*.cjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    // process.env is read only in infrastructure/config/env.ts (see .kiro/steering/tech-stack.md).
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/infrastructure/config/env.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration through infrastructure/config/env.ts.",
        },
      ],
    },
  },
  {
    // Core has no default exports. Tenant tool handlers default-export by contract.
    // Only the tenant registry may create a TenantContext (tenant-isolation rule 1). The type
    // is branded, so the only way around the registry is a cast, which is forbidden here.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_DEFAULT_EXPORT_IN_CORE, ...NO_TENANT_CONTEXT_CASTS],
    },
  },
  {
    files: ["packages/core/src/application/tenants/in-memory-tenant-registry.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_DEFAULT_EXPORT_IN_CORE],
    },
  },
  {
    files: ["examples/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...NO_TENANT_CONTEXT_CASTS],
    },
  },
  {
    files: ["**/*.test.ts", "packages/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.commonjs },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  prettier,
);
