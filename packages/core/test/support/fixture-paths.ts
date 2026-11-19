import { fileURLToPath } from "node:url";

const here = (relative: string): string => fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url));

export const FIXTURES = {
  validTenants: here("./tenants/valid"),
  invalidTenants: here("./tenants/invalid"),
  alpha: here("./tenants/valid/fixture-alpha"),
  beta: here("./tenants/valid/fixture-beta"),
  invalid: (name: string): string => here(`./tenants/invalid/${name}`),
  escapedHandler: here("./outside/escaped-handler.js"),
} as const;
