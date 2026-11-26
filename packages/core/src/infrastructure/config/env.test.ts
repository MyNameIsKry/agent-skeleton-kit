import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../domain/errors.js";
import { loadEnv } from "./env.js";

const providerEnv = { LLM_API_KEY: "sk-test-secret-value", LLM_MODEL: "test-model" };

function configError(fn: () => unknown): ConfigurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected a ConfigurationError");
}

describe("loadEnv", () => {
  it("parses only the tenant group without requiring provider settings", () => {
    expect(loadEnv(["tenants"], {})).toEqual({ tenants: { tenantsDir: "./examples" } });
  });

  it("names a missing LLM_API_KEY and points to .env.example", () => {
    const error = configError(() => loadEnv(["providers"], { LLM_MODEL: "m" }));
    expect(error.issues).toEqual(["LLM_API_KEY: is required"]);
    expect(error.message).toContain(".env.example");
  });

  it("treats blank values as unset", () => {
    const error = configError(() => loadEnv(["providers"], { LLM_API_KEY: "   ", LLM_MODEL: "" }));
    expect(error.issues).toEqual(["LLM_API_KEY: is required", "LLM_MODEL: is required"]);
  });

  it("reports every invalid variable across groups at once", () => {
    const error = configError(() =>
      loadEnv(["infrastructure", "server", "limits"], {
        MONGODB_URI: "postgres://x",
        PORT: "70000",
        AUTO_INGEST: "yes",
        MAX_TOOL_ITERATIONS: "2.5",
      }),
    );
    expect(error.issues).toEqual([
      "MONGODB_URI: must start with mongodb:// or mongodb+srv://",
      "REDIS_URL: is required",
      "PORT: must be an integer between 1 and 65535",
      "AUTO_INGEST: must be true or false",
      "MAX_TOOL_ITERATIONS: must be an integer between 1 and 20",
    ]);
  });

  it("never includes variable values in the error", () => {
    const error = configError(() =>
      loadEnv(["providers"], { ...providerEnv, LLM_BASE_URL: "not-a-url-sk-test-secret-value" }),
    );
    expect(error.issues).toEqual(["LLM_BASE_URL: must be an http(s) URL"]);
    expect(error.message).not.toContain("sk-test-secret-value");
  });

  it("applies defaults and reuses LLM settings for embeddings when unset", () => {
    const env = loadEnv(["providers", "server", "limits"], providerEnv);
    expect(env.providers).toEqual({
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-secret-value",
        model: "test-model",
        timeoutMs: 45_000,
      },
      embedding: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-secret-value",
        model: "text-embedding-3-small",
        dimensions: 1536,
        timeoutMs: 30_000,
      },
    });
    expect(env.server).toEqual({ port: 3000, autoIngest: true, logLevel: "info" });
    expect(env.limits).toEqual({ maxToolIterations: 5, toolTimeoutMs: 10_000 });
  });

  it("does not send the LLM key to a different embedding host", () => {
    const env = loadEnv(["providers"], { ...providerEnv, EMBEDDING_BASE_URL: "http://localhost:11434/v1" });
    expect(env.providers.embedding.baseUrl).toBe("http://localhost:11434/v1");
    expect(env.providers.embedding.apiKey).toBeUndefined();
  });

  it("reuses the LLM key when the embedding URL has the same origin as the LLM", () => {
    const env = loadEnv(["providers"], {
      ...providerEnv,
      LLM_BASE_URL: "https://api.example.com/v1",
      EMBEDDING_BASE_URL: "https://api.example.com/v1/",
    });
    expect(env.providers.embedding.apiKey).toBe("sk-test-secret-value");
  });

  it("uses an explicit embedding key for a different host", () => {
    const env = loadEnv(["providers"], {
      ...providerEnv,
      EMBEDDING_BASE_URL: "https://embeddings.example.com/v1",
      EMBEDDING_API_KEY: "emb-key",
    });
    expect(env.providers.embedding.apiKey).toBe("emb-key");
  });

  it("parses an optional LLM_TEMPERATURE and leaves it unset when blank", () => {
    const withTemperature = (value: string) =>
      loadEnv(["providers"], { ...providerEnv, LLM_TEMPERATURE: value }).providers.llm.temperature;
    expect(withTemperature("0.2")).toBe(0.2);
    expect(withTemperature("")).toBeUndefined();
    const error = configError(() => loadEnv(["providers"], { ...providerEnv, LLM_TEMPERATURE: "3" }));
    expect(error.issues).toEqual(["LLM_TEMPERATURE: must be a number between 0 and 2"]);
  });

  it("rejects timeouts outside 1000 to 300000 ms", () => {
    const error = configError(() =>
      loadEnv(["providers"], { ...providerEnv, LLM_TIMEOUT_MS: "500", EMBEDDING_TIMEOUT_MS: "999999" }),
    );
    expect(error.issues).toEqual([
      "LLM_TIMEOUT_MS: must be an integer between 1000 and 300000",
      "EMBEDDING_TIMEOUT_MS: must be an integer between 1000 and 300000",
    ]);
  });

  it("uses explicit embedding settings and parses typed values", () => {
    const env = loadEnv(["providers", "server"], {
      ...providerEnv,
      EMBEDDING_BASE_URL: "http://localhost:11434/v1",
      EMBEDDING_API_KEY: "other",
      EMBEDDING_DIMENSIONS: "768",
      LLM_TIMEOUT_MS: "90000",
      EMBEDDING_TIMEOUT_MS: "5000",
      PORT: "8080",
      AUTO_INGEST: "0",
      LOG_LEVEL: "debug",
    });
    expect(env.providers.embedding).toEqual({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "other",
      model: "text-embedding-3-small",
      dimensions: 768,
      timeoutMs: 5_000,
    });
    expect(env.providers.llm.timeoutMs).toBe(90_000);
    expect(env.server).toEqual({ port: 8080, autoIngest: false, logLevel: "debug" });
  });
});
