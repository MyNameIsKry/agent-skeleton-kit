/**
 * The only module that reads process.env. Variables are parsed in groups so that each
 * entrypoint requires only what it uses (see design.md section 4a).
 */
import { z } from "zod";
import { ConfigurationError } from "../../domain/errors.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Blank values count as unset, so `KEY=` in .env behaves like a missing key. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const required = (schema: z.ZodType<string, string>) =>
  z.preprocess(blankToUndefined, z.string({ error: "is required" }).trim().pipe(schema));

const optionalString = () => z.preprocess(blankToUndefined, z.string().trim().optional());

const withDefault = <T>(schema: z.ZodType<T>, fallback: T) =>
  z.preprocess(blankToUndefined, schema.optional()).transform((value) => value ?? fallback);

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

const integer = (min: number, max: number) =>
  z.coerce
    .number({ error: `must be an integer between ${min} and ${max}` })
    .int({ error: `must be an integer between ${min} and ${max}` })
    .min(min, { error: `must be an integer between ${min} and ${max}` })
    .max(max, { error: `must be an integer between ${min} and ${max}` });

const boolean = z
  .enum(["true", "false", "1", "0"], { error: "must be true or false" })
  .transform((value) => value === "true" || value === "1");

const groupSchemas = {
  tenants: z
    .object({ TENANTS_DIR: withDefault(z.string().trim(), "./examples") })
    .transform((env) => ({ tenantsDir: env.TENANTS_DIR })),

  infrastructure: z
    .object({
      MONGODB_URI: required(
        z.string().regex(/^mongodb(\+srv)?:\/\//, "must start with mongodb:// or mongodb+srv://"),
      ),
      REDIS_URL: required(z.string().regex(/^rediss?:\/\//, "must start with redis:// or rediss://")),
    })
    .transform((env) => ({ mongodbUri: env.MONGODB_URI, redisUrl: env.REDIS_URL })),

  providers: z
    .object({
      LLM_BASE_URL: withDefault(httpUrl, "https://api.openai.com/v1"),
      LLM_API_KEY: required(z.string()),
      LLM_MODEL: required(z.string()),
      EMBEDDING_BASE_URL: z.preprocess(blankToUndefined, httpUrl.optional()),
      EMBEDDING_API_KEY: optionalString(),
      EMBEDDING_MODEL: withDefault(z.string().trim(), "text-embedding-3-small"),
      EMBEDDING_DIMENSIONS: withDefault(integer(1, 8192), 1536),
    })
    .transform((env) => ({
      llm: { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL },
      embedding: {
        baseUrl: env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL,
        apiKey: env.EMBEDDING_API_KEY ?? env.LLM_API_KEY,
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      },
    })),

  server: z
    .object({
      PORT: withDefault(integer(1, 65535), 3000),
      AUTO_INGEST: withDefault(boolean, true),
      LOG_LEVEL: withDefault(
        z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(", ")}` }),
        "info",
      ),
    })
    .transform((env) => ({ port: env.PORT, autoIngest: env.AUTO_INGEST, logLevel: env.LOG_LEVEL })),

  limits: z
    .object({
      MAX_TOOL_ITERATIONS: withDefault(integer(1, 20), 5),
      TOOL_TIMEOUT_MS: withDefault(integer(100, 120_000), 10_000),
    })
    .transform((env) => ({ maxToolIterations: env.MAX_TOOL_ITERATIONS, toolTimeoutMs: env.TOOL_TIMEOUT_MS })),
};

export type EnvGroup = keyof typeof groupSchemas;
export type Env = { [G in EnvGroup]: z.output<(typeof groupSchemas)[G]> };

const FOOTER = "Copy .env.example to .env and set the values above. See .env.example for descriptions.";

/**
 * Parses the requested groups and fails with every problem at once.
 * Error messages name variables and reasons, never values.
 */
export function loadEnv<const G extends EnvGroup>(
  groups: readonly G[],
  source: EnvSource = process.env,
): Pick<Env, G> {
  const issues: string[] = [];
  const result: Partial<Record<EnvGroup, unknown>> = {};

  for (const group of new Set(groups)) {
    const parsed = groupSchemas[group].safeParse(source);
    if (parsed.success) {
      result[group] = parsed.data;
    } else {
      for (const issue of parsed.error.issues) {
        issues.push(`${issue.path.map(String).join(".")}: ${issue.message}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigurationError("Invalid environment configuration:", issues, FOOTER);
  }
  return result as Pick<Env, G>;
}
