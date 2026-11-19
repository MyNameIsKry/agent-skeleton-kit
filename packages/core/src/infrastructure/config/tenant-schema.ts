import { z } from "zod";
import { TENANT_ID_PATTERN, TOOL_NAME_PATTERN } from "../../domain/tenant.js";

const text = (max: number) =>
  z
    .string({ error: (issue) => (issue.input === undefined ? "is required" : "must be a string") })
    .trim()
    .min(1, "must not be empty")
    .max(max, `must be at most ${max} characters`);

const toolSchema = z.strictObject({
  name: z
    .string()
    .regex(TOOL_NAME_PATTERN, "must be snake_case: a lowercase letter, then up to 63 of [a-z0-9_]"),
  description: text(1024),
  handler: text(256),
  parameters: z.record(z.string(), z.unknown(), { error: "must be a JSON Schema object" }),
});

const retrievalSchema = z.strictObject({
  topK: z.int().min(1).max(20).default(5),
  minScore: z.number().min(0).max(1).default(0.6),
});

const chunkingSchema = z
  .strictObject({
    maxTokens: z.int().min(50).max(2000).default(400),
    overlap: z.int().min(0).max(500).default(50),
  })
  .refine((c) => c.overlap < c.maxTokens, {
    error: "overlap must be smaller than maxTokens",
    path: ["overlap"],
  });

/** Shape of tenant.yaml / tenant.json. Unknown keys are rejected to catch typos. */
export const tenantFileSchema = z.strictObject({
  id: z.string().regex(TENANT_ID_PATTERN, "must match ^[a-z0-9][a-z0-9-]{1,62}$"),
  displayName: text(80),
  description: text(300),
  systemPrompt: text(20_000),
  retrieval: retrievalSchema.prefault({}),
  chunking: chunkingSchema.prefault({}),
  tools: z.array(toolSchema).max(32, "a tenant can declare at most 32 tools").default([]),
});

export type TenantFile = z.output<typeof tenantFileSchema>;

/** Formats a Zod issue path as `tools[0].parameters`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`))
    .join("");
}
