---
inclusion: always
---

# Tech stack and conventions

## Runtime and language

- Node.js 22 LTS, TypeScript 5.x, ESM only (`"type": "module"`, `module`/`moduleResolution`: `NodeNext`).
- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
- No `any`. Use `unknown` and narrow with Zod or type guards.
- npm workspaces: `packages/*`, `examples/*`. Core package name: `@agent-skeleton/core`.

## Libraries (use these, do not add alternatives without updating this file)

| Concern | Choice |
|---|---|
| HTTP server | Fastify |
| Validation (config, requests, env) | Zod |
| Tool argument validation | Ajv (`Ajv2020`, JSON Schema 2020-12 only) with `ajv-formats` |
| Queue | BullMQ on Redis |
| Database and vector search | MongoDB driver, `$vectorSearch` |
| Logging | pino (structured JSON, redact secrets) |
| PDF parsing | `unpdf` (or `pdf-parse` if `unpdf` is unsuitable) |
| Config files | `yaml` package for YAML, native JSON |
| Tests | Vitest, fast-check for chunker properties |
| Lint and format | ESLint (typescript-eslint, strict) and Prettier |
| Architecture check | dependency-cruiser |
| LLM and embedding HTTP | Built-in `fetch` (Node 22), responses validated with Zod. No vendor SDK. |
| Runtime TS for dev | `tsx` (dev only). Production images run compiled JS. |

## Infrastructure

- MongoDB: image `mongodb/mongodb-atlas-local` (provides `$vectorSearch` locally and runs as a replica set, so transactions work). Pin an explicit tag, never `latest`.
- Redis 7 (alpine) for BullMQ.
- Docker Compose services: `mongo`, `redis`, `api`, `worker`. `api` and `worker` share one image and differ by command. Containers run as non-root. Mongo and Redis ports are not published by default.

## LLM and embeddings

- Ports `LlmProvider` and `EmbeddingProvider` live in `domain`. The first adapter speaks the OpenAI-compatible HTTP API, so any compatible endpoint works by changing env vars.
- Default embedding: 1536 dimensions (`text-embedding-3-small`). Dimensions come from `EMBEDDING_DIMENSIONS`. Changing the model requires reindexing; chunks store `embeddingModel` to detect drift.
- Tests never call a real LLM. Use `FakeLlmProvider` and `FakeEmbeddingProvider`.

## Environment variables (parsed once in `infrastructure/config/env.ts` with Zod)

`MONGODB_URI`, `REDIS_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_TIMEOUT_MS`, `TENANTS_DIR`, `PORT`, `AUTO_INGEST`, `LOG_LEVEL`, `MAX_TOOL_ITERATIONS`, `TOOL_TIMEOUT_MS`.

Never read `process.env` outside that one module. Never log secrets. `.env` is git-ignored, `.env.example` is committed.

## Commands (root `package.json` scripts; keep these names stable)

`build`, `typecheck`, `lint`, `test` (unit), `test:integration` (needs `docker compose up -d --wait mongo redis`), `test:isolation`, `arch` (dependency-cruiser), `validate-tenant -- <dir>`, `ingest -- --tenant <id>`, `check:zero-core` (see `design.md`), `dev:api`, `dev:worker`.

## Code conventions

- Files `kebab-case.ts`. Types and classes `PascalCase`. Functions and variables `camelCase`. Constants `SCREAMING_SNAKE_CASE`.
- Imports use explicit `.js` extensions (NodeNext).
- Errors: throw typed errors extending `AppError` (`code`, `httpStatus`, `safeMessage`). Never leak internal messages or secrets to HTTP clients.
- Validate at trust boundaries only (HTTP input, env, tenant files, LLM tool arguments, handler results). Inside the core, trust the types.
- Prefer pure functions and constructor injection. Wiring happens only in `main.api.ts` and `main.worker.ts`.
- No default exports in core (except tenant tool handlers, which must default-export by contract).
- Every public function that touches tenant data takes a `TenantContext` as its first parameter.
