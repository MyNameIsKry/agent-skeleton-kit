---
inclusion: fileMatch
fileMatchPattern: "**/*.test.ts"
---

# Testing conventions

- Vitest. Test files sit next to the code (`*.test.ts`) for unit tests, and under `packages/core/test/{integration,isolation,arch}/` for the rest.
- **Unit tests** run with no network, no Docker, no real LLM. Use `FakeLlmProvider` (scripted responses, including tool calls), `FakeEmbeddingProvider` (deterministic hash-based vectors of the configured dimension), and in-memory repository fakes that still enforce `TenantContext` scoping.
- **Integration tests** (`npm run test:integration`) use the real Mongo (atlas-local) and Redis (BullMQ tests; `REDIS_URL` overrides `redis://127.0.0.1:6379`) from `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --wait mongo redis` (the test file publishes ports on 127.0.0.1). `MONGODB_URI` overrides the default `mongodb://127.0.0.1:27017/?directConnection=true`. They use a unique database name per run and clean up after themselves.
- **Isolation tests** (`npm run test:isolation`) implement the list in `tenant-isolation.md`. They run in CI on every push and must not be skipped or weakened to make a build pass. Tests that need Mongo fail with start instructions when it is unreachable; they never skip.
- **Architecture test** (`npm run arch`) fails if `domain` or `application` import from `infrastructure`, `interfaces`, or forbidden third-party packages.
- **Zero-core check** (`npm run check:zero-core`) copies an example tenant to a temp directory under a new id, boots the registry against it, and fails if anything under `packages/core` is touched or any example tenant id appears in `packages/core/src`.
- Property-based tests (fast-check) for the chunker: chunks never exceed `maxTokens` (approximate), every non-whitespace character of the input is covered, chunk ids are deterministic.
- Name tests by behavior: `it("rejects a tool call that is not in the tenant allowlist")`.
- Assert on outcomes, not on mock call counts, unless the call itself is the requirement.
