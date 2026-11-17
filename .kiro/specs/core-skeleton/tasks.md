# Implementation plan: core-skeleton

Tasks marked `*` are optional polish. Requirement numbers refer to `requirements.md`.

- [ ] 1. Project foundation and Kiro workspace
  - [x] 1.1 Create steering files (`product`, `tech-stack`, `tenant-isolation`, `architecture-boundaries`, `tenant-plugin-conventions`, `testing`, `submission-checklist`)
    - _Requirements: 13.3_
  - [x] 1.2 Create specs for `core-skeleton`, `ops-onboarding-copilot`, `ecommerce-order-concierge`
    - _Requirements: 10.4, 13.3_
  - [x] 1.3 Create hooks that guard architecture boundaries and `.kiro` tracking, and remind validation and isolation checks
    - _Requirements: 13.2, 13.3_
  - [ ] 1.4 Initialize npm workspaces (`packages/core`, `examples/*`), strict `tsconfig`, ESLint, Prettier, Vitest, dependency-cruiser config
    - _Requirements: 13.1, 13.2_
  - [ ] 1.5 Add `.gitignore` (must not ignore `.kiro`), `.env.example`, confirm `LICENSE` is OSI-approved
    - _Requirements: 11.1, 13.3_
  - [ ] 1.6 Add `docker-compose.yml` with `mongo` (atlas-local, pinned) and `redis`, with health checks
    - _Requirements: 11.2, 11.4_
  - [ ] 1.7 Add GitHub Actions workflow: install, lint, typecheck, unit, arch, isolation, zero-core
    - _Requirements: 13.1_

- [ ] 2. Domain model, errors, ports
  - [ ] 2.1 Define domain types, `TenantContext` (frozen), `AppError` hierarchy
    - _Requirements: 2.1, 6.7_
  - [ ] 2.2 Define all ports in `domain/ports.ts`, plus public `ToolHandler`, `ToolContext` types and `index.ts`
    - _Requirements: 7.4, 8.1_
  - [ ] 2.3 Implement fakes (`FakeLlmProvider`, `FakeEmbeddingProvider`, in-memory repositories) in `testing.ts`
    - _Requirements: 8.4_

- [ ] 3. Configuration and tenant loading
  - [ ] 3.1 Implement env parsing with Zod and actionable startup errors
    - _Requirements: 8.2, 11.1_
  - [ ] 3.2 Implement tenant loader (YAML/JSON, Zod schema, id rules, Ajv schema compile)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [ ] 3.3 Implement handler loader with `realpath` containment and extensionless resolution
    - _Requirements: 1.6, 2.6_
  - [ ] 3.4 Implement `TenantRegistry` and `validate-tenant` CLI
    - _Requirements: 1.7, 2.1_
  - [ ] 3.5 Unit tests: invalid configs, duplicate ids, symlink escape, missing handler
    - _Requirements: 1.3, 1.4, 1.6_

- [ ] 4. Provider adapters
  - [ ] 4.1 OpenAI-compatible `LlmProvider` (chat with tools, timeouts, error mapping to `provider_error`)
    - _Requirements: 6.7, 8.1_
  - [ ] 4.2 OpenAI-compatible `EmbeddingProvider` (batching, dimension check)
    - _Requirements: 8.1, 8.3_
  - [ ] 4.3 Unit tests with mocked HTTP: success, 429, 5xx, malformed tool calls
    - _Requirements: 6.7_

- [ ] 5. MongoDB infrastructure
  - [ ] 5.1 Mongo client, repositories (`documents`, `chunks`, `conversations`) with `TenantContext`-scoped filters
    - _Requirements: 2.3, 2.4, 2.5_
  - [ ] 5.2 `ensureInfrastructure`: indexes, vector index creation, dimension check, wait for queryable
    - _Requirements: 8.3, 11.3_
  - [ ] 5.3 `VectorSearch` implementation: `$vectorSearch` with pre-filter, `$match`, score threshold, foreign-result guard
    - _Requirements: 5.1, 5.3_
  - [ ] 5.4 `activateVersion` transaction and version cleanup
    - _Requirements: 4.2, 4.3, 4.6_
  - [ ] 5.5 `TenantDataStore` backed by `tool_records`
    - _Requirements: 7.4, 7.6_
  - [ ] 5.6 Integration tests against compose Mongo (tenant filter, version swap, deterministic ids)
    - _Requirements: 2.4, 4.3, 4.4_

- [ ] 6. Ingestion pipeline
  - [ ] 6.1 Markdown parser and PDF parser
    - _Requirements: 3.1, 3.7_
  - [ ] 6.2 Heading-aware chunker with packing and overlap, deterministic chunk ids
    - _Requirements: 3.3, 3.7, 4.4_
  - [ ] 6.3 fast-check tests for chunker (size bound, coverage, id determinism)
    - _Requirements: 4.4_
  - [ ] 6.4 BullMQ queue adapter and worker (attempts, backoff, graceful shutdown)
    - _Requirements: 3.2, 3.5, 12.3_
  - [ ] 6.5 `IngestionService`: scan, hash, skip unchanged, enqueue, remove deleted sources
    - _Requirements: 3.2, 3.6, 4.1, 4.5_
  - [ ] 6.6 `IngestDocumentUseCase`: status transitions, embed batches, upsert inactive chunks, activate, cleanup
    - _Requirements: 3.3, 3.4, 4.2, 4.3, 4.6_
  - [ ] 6.7 `ingest` CLI and integration test (end to end with fake embeddings)
    - _Requirements: 3.1, 3.4_

- [ ] 7. Retrieval, chat, and agent loop
  - [ ] 7.1 `Retriever` (embed query, search, citations mapping, empty-context behavior)
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ] 7.2 `PromptBuilder` with core guardrails, delimited context, history window
    - _Requirements: 6.2, 6.3_
  - [ ] 7.3 `ToolRuntime`: allowlist, Ajv validation, timeout, error shaping, `ConfigFileToolSource`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [ ] 7.4 `AgentLoop` and `ChatService` with iteration cap, deadline, persistence, truncation flag
    - _Requirements: 6.4, 6.5, 6.6_
  - [ ] 7.5 Unit tests with `FakeLlmProvider`: tool success, invalid args, foreign tool, handler throw, loop cap
    - _Requirements: 7.2, 7.3, 7.5, 6.4_
  - [ ] **Checkpoint A:** vertical slice. One tenant ingests a document and answers a question with a citation through a script.

- [ ] 8. HTTP API and Playground
  - [ ] 8.1 Fastify server, request-id, error handler, pino logging with redaction
    - _Requirements: 12.1_
  - [ ] 8.2 Tenant resolver middleware (400, 404) and routes: tenants, chat, ingest, documents, health
    - _Requirements: 2.1, 2.2, 6.1, 12.2_
  - [ ] 8.3 `main.api.ts` and `main.worker.ts` composition roots with the startup sequence and `AUTO_INGEST`
    - _Requirements: 3.6, 11.3_
  - [ ] 8.4 Playground: tenant dropdown, chat, citations panel, tool-call cards, ingestion status, error states
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [ ] 8.5* Records route and playground records view
    - _Requirements: 9.6_
  - [ ] 8.6 Route tests with `fastify.inject` (validation, 404, error shapes)
    - _Requirements: 2.2, 6.1, 6.7_

- [ ] 9. Isolation and architecture gates
  - [ ] 9.1 Isolation test suite P1 to P4 (canary chunk, foreign tool, session cross-use, unknown tenant, handler escape)
    - _Requirements: 2.2, 2.4, 2.5, 5.3, 7.2_
  - [ ] 9.2 dependency-cruiser rules for domain and application boundaries
    - _Requirements: 13.2_
  - [ ] 9.3 `check:zero-core` script (P8) and CI step
    - _Requirements: 10.2, 10.3_

- [ ] 10. Example tenants (each has its own spec)
  - [ ] 10.1 Implement `ops-onboarding-copilot` (see its spec)
    - _Requirements: 10.1_
  - [ ] 10.2 Implement `ecommerce-order-concierge` (see its spec)
    - _Requirements: 10.1_
  - [ ] **Checkpoint B:** both tenants run side by side. `git diff --stat` for the second tenant shows no change under `packages/core`.

- [ ] 11. Packaging and developer experience
  - [ ] 11.1 Multi-stage Dockerfile (compile core and example handlers, non-root runtime)
    - _Requirements: 11.4_
  - [ ] 11.2 Extend compose with `api` and `worker`, health checks, `depends_on` with `service_healthy`
    - _Requirements: 11.1, 11.2_
  - [ ] 11.3 Clean-clone test: fresh directory, `cp .env.example .env`, set key, `docker compose up --build`, playground works
    - _Requirements: 11.1, 11.3_
  - [ ] 11.4 Startup failure messages: missing API key, dimension mismatch, bad tenant file
    - _Requirements: 1.3, 8.2, 8.3_

- [ ] 12. Documentation and submission
  - [ ] 12.1 README: pitch, architecture diagram, quick start, add-a-tenant guide, isolation explanation, "How I used Kiro", roadmap
    - _Requirements: 11.5, 13.4_
  - [ ] 12.2 Record the demo video (script in `.kiro/steering/submission-checklist.md`)
    - _Requirements: 13.4_
  - [ ] 12.3 Run the submission checklist and verify `.kiro/` is tracked
    - _Requirements: 13.3_
