# Implementation plan: core-skeleton

Each top-level task is one pull request: task group N is PR N. A PR merges only when its own tests pass and CI is green.

- Tests ship in the same PR as the code they cover. Isolation tests (P1 to P4 in `design.md` section 8) go to `packages/core/test/isolation/` in the PR that introduces the protected code, and CI gains each new test step in the PR that creates it.
- Test fakes are added in the first PR that uses them.
- Tasks marked `*` are optional polish. Requirement numbers refer to `requirements.md`.

Merge order: 1, 2, then 3, 4, and 6 in any order, then 5 (needs 4), 7 (needs 3, 5, 6), 8, 9, 10, 11, 12, 13.

- [x] 1. PR 1: Project foundation, tooling, and CI
  - [x] 1.1 Create steering files (`product`, `tech-stack`, `tenant-isolation`, `architecture-boundaries`, `tenant-plugin-conventions`, `testing`, `submission-checklist`)
    - _Committed directly to `main` before the PR workflow started._
    - _Requirements: 13.3_
  - [x] 1.2 Create specs for `core-skeleton`, `ops-onboarding-copilot`, `ecommerce-order-concierge`
    - _Requirements: 10.4, 13.3_
  - [x] 1.3 Create hooks that guard architecture boundaries and `.kiro` tracking, and remind validation and isolation checks
    - _Requirements: 13.2, 13.3_
  - [x] 1.4 Initialize npm workspaces (`packages/core`, `examples/*`), strict `tsconfig`, ESLint, Prettier, Vitest. Add a placeholder `packages/core/src/index.ts` so typecheck and tests have input.
    - _Requirements: 13.1_
  - [x] 1.5 Add `.gitignore` (must not ignore `.kiro`) and `.env.example`. `LICENSE` is MIT (already confirmed).
    - _Requirements: 11.1, 13.3_
  - [x] 1.6 Add `docker-compose.yml` with `mongo` (atlas-local, pinned tag) and `redis`, with health checks
    - _Requirements: 11.2, 11.4_
  - [x] 1.7 Add dependency-cruiser rules for `domain` and `application` boundaries and the `arch` script
    - _Requirements: 13.2_
  - [x] 1.8 Add GitHub Actions workflow with install, lint, typecheck, unit tests, and arch
    - _Requirements: 13.1_

- [x] 2. PR 2: Domain model and tenant loading
  - [x] 2.1 Define domain types, `TenantContext` (frozen), and the `AppError` hierarchy
    - _Requirements: 2.1, 6.7_
  - [x] 2.2 Define all ports in `domain/ports.ts`, plus the public `ToolHandler` and `ToolContext` types exported from `index.ts`
    - _Requirements: 7.4, 8.1_
  - [x] 2.3 Implement env parsing with Zod. Missing or invalid LLM and embedding settings fail at startup with a message naming the variable and pointing to `.env.example`.
    - _Requirements: 8.2, 11.1_
  - [x] 2.4 Implement the tenant loader (YAML/JSON, Zod schema, id rules, Ajv schema compile). Errors name the tenant directory, field path, and reason.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [x] 2.5 Implement the handler loader with `realpath` containment and extensionless resolution
    - _Requirements: 1.6, 2.6_
  - [x] 2.6 Implement `TenantRegistry` and the `validate-tenant` CLI and script
    - _Requirements: 1.7, 2.1_
  - [x] 2.7 Add fixture tenants under `packages/core/test/fixtures/tenants/`: two valid tenants (`fixture-alpha`, `fixture-beta`, each with one knowledge document and one tool) and invalid variants
    - _Requirements: 1.3, 1.4, 1.6_
  - [x] 2.8 Unit tests: invalid configs, duplicate ids, id and directory mismatch, missing handler
    - _Requirements: 1.3, 1.4, 1.6_
  - [x] 2.9 Isolation test P3: a handler path that escapes the tenant directory (`..` or symlink) fails at load. Add the `test:isolation` script and its CI step.
    - _Requirements: 1.6_

- [x] 3. PR 3: Provider adapters
  - [x] 3.1 OpenAI-compatible `LlmProvider` (chat with tools, timeouts, error mapping to `provider_error`)
    - _Requirements: 6.7, 8.1_
  - [x] 3.2 OpenAI-compatible `EmbeddingProvider` (batching, dimension check)
    - _Requirements: 8.1, 8.3_
  - [x] 3.3 Unit tests with mocked HTTP: success, 429, 5xx, malformed tool calls
    - _Requirements: 6.7_

- [x] 4. PR 4: MongoDB infrastructure
  - [x] 4.1 Mongo client and repositories (`documents`, `chunks`, `conversations`) with `TenantContext`-scoped filters
    - _Requirements: 2.3, 2.4, 2.5_
  - [x] 4.2 `ensureInfrastructure`: indexes, vector index creation, wait until queryable. A dimension mismatch fails startup with an explicit reindex instruction.
    - _Requirements: 8.3, 11.3_
  - [x] 4.3 `VectorSearch` implementation: `$vectorSearch` with pre-filter, `$match`, score threshold, foreign-result guard
    - _Requirements: 5.1, 5.3_
  - [x] 4.4 `activateVersion` transaction and version cleanup
    - _Requirements: 4.2, 4.3, 4.6_
  - [x] 4.5 `TenantDataStore` backed by `tool_records`
    - _Requirements: 7.4, 7.6_
  - [x] 4.6 Integration tests against compose Mongo (tenant filter, version swap, deterministic ids). Add the `test:integration` script and a CI job that starts `mongo` and `redis`.
    - _Requirements: 2.4, 4.3, 4.4_
  - [x] 4.7 Isolation test P1: a canary chunk stored for `fixture-alpha` is never returned by vector search or repositories for `fixture-beta`
    - _Requirements: 2.4, 5.3_

- [x] 5. PR 5: Ingestion pipeline
  - _If this PR grows too large, 5.1 to 5.3 (no I/O) can ship as a separate PR first._
  - [x] 5.1 Markdown parser and PDF parser
    - _Requirements: 3.1, 3.7_
  - [x] 5.2 Heading-aware chunker with packing and overlap, deterministic chunk ids
    - _Requirements: 3.3, 3.7, 4.4_
  - [x] 5.3 fast-check tests for the chunker (size bound, coverage, id determinism)
    - _Requirements: 4.4_
  - [x] 5.4 Add `FakeEmbeddingProvider` and in-memory repositories (still enforcing `TenantContext` scoping) to `testing.ts`
    - _Requirements: 8.4_
  - [x] 5.5 BullMQ queue adapter and worker (attempts, backoff, graceful shutdown)
    - _Requirements: 3.2, 3.5, 12.3_
  - [x] 5.6 `IngestionService`: scan, hash, skip unchanged, enqueue, remove deleted sources
    - _Requirements: 3.2, 3.6, 4.1, 4.5_
  - [x] 5.7 `IngestDocumentUseCase`: status transitions, embed batches, upsert inactive chunks, activate, cleanup
    - _Requirements: 3.3, 3.4, 4.2, 4.3, 4.6_
  - [x] 5.8 `ingest` CLI and an end-to-end integration test with fake embeddings
    - _Requirements: 3.1, 3.4_

- [ ] 6. PR 6: Tool runtime
  - [x] 6.1 `ToolRuntime` (allowlist, Ajv validation, timeout, error shaping) and `ConfigFileToolSource`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 6.2 Add an in-memory `TenantDataStore` fake to `testing.ts`
    - _Requirements: 7.6, 8.4_
  - [x] 6.3 Unit tests: valid call, invalid arguments (handler not called), handler throws, handler timeout
    - _Requirements: 7.3, 7.5_
  - [x] 6.4 Isolation test P2: a tool call naming another tenant's tool is rejected and no handler runs
    - _Requirements: 7.2_

- [ ] 7. PR 7: Retrieval, chat, and agent loop
  - [ ] 7.1 `Retriever` (embed query, search, citation mapping, empty-context behavior)
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ] 7.2 `PromptBuilder` with core guardrails, delimited context, history window
    - _Requirements: 6.2, 6.3_
  - [ ] 7.3 Add `FakeLlmProvider` (scripted responses, including tool calls) to `testing.ts`
    - _Requirements: 8.4_
  - [ ] 7.4 `AgentLoop` and `ChatService` with iteration cap, deadline, persistence, truncation flag. Add `finishReason` to `LlmResponse` and handle `length` and `content_filter` (flag the reply instead of presenting it as complete).
    - _Requirements: 6.4, 6.5, 6.6_
  - [ ] 7.5 Unit tests: tool call through the loop, iteration cap (P7), provider failure mapped to `provider_error`
    - _Requirements: 6.4, 6.7_
  - [ ] 7.6 Isolation test P4: a `sessionId` created under `fixture-alpha` returns no history under `fixture-beta`
    - _Requirements: 2.5_
  - [ ] 7.7 **Checkpoint A:** vertical slice test. A fixture tenant ingests a document and answers a question with a citation (fake providers in CI, real provider in a manual run).
    - _Requirements: 3.3, 5.2, 6.5_

- [ ] 8. PR 8: HTTP API and composition roots
  - [ ] 8.1 Fastify server, request id, error handler, pino logging with redaction
    - _Requirements: 12.1_
  - [ ] 8.2 Tenant resolver middleware (400, 404) and routes: tenants, chat, ingest, documents, health
    - _Requirements: 2.1, 2.2, 6.1, 12.2_
  - [ ] 8.3 `main.api.ts` and `main.worker.ts` composition roots with the startup sequence, `AUTO_INGEST`, and the `dev:api` and `dev:worker` scripts
    - _Requirements: 3.6, 11.3_
  - [ ] 8.4 Route tests with `fastify.inject` (validation, error shapes)
    - _Requirements: 6.1, 6.7_
  - [ ] 8.5 Isolation test: a missing tenant header returns 400, an unknown tenant returns 404, and neither touches data
    - _Requirements: 2.2_

- [ ] 9. PR 9: Docker packaging
  - [ ] 9.1 Multi-stage Dockerfile (compile core and example handlers, non-root runtime)
    - _Requirements: 11.4_
  - [ ] 9.2 Extend compose with `api` and `worker`, health checks, and `depends_on` with `service_healthy`
    - _Requirements: 11.1, 11.2_
  - [ ] 9.3 Verify the startup failure messages from 2.3, 2.4, and 4.2 inside containers: missing API key, bad tenant file, dimension mismatch
    - _Requirements: 1.3, 8.2, 8.3_
  - [ ] 9.4 Clean-clone test: fresh directory, `cp .env.example .env`, set key, `docker compose up --build`, and `/healthz` reports ready
    - _Requirements: 11.1, 11.3_

- [ ] 10. PR 10: Web Playground
  - [ ] 10.1 Playground: tenant dropdown, chat, citations panel, tool-call cards, ingestion status, error states
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [ ] 10.2* Records route and playground records view
    - _Requirements: 9.6_

- [ ] 11. PR 11: Ops tenant and zero-core check
  - [ ] 11.1 Implement `ops-onboarding-copilot` (see `.kiro/specs/ops-onboarding-copilot/tasks.md`)
    - _Requirements: 10.1_
  - [ ] 11.2 Add the `check:zero-core` script (P8) and its CI step
    - _Requirements: 10.2, 10.3_

- [ ] 12. PR 12: E-commerce tenant (must not touch `packages/core`)
  - [ ] 12.1 Implement `ecommerce-order-concierge` (see `.kiro/specs/ecommerce-order-concierge/tasks.md`)
    - _Requirements: 10.1_
  - [ ] 12.2 **Checkpoint B:** both tenants run side by side, and this PR's diff contains no file under `packages/core`. Link the PR from the README and the Devpost page as evidence.
    - _Requirements: 10.1, 10.2_

- [ ] 13. PR 13: Documentation and submission
  - [ ] 13.1 Update the README: remove *(target)* labels for working features, add a screenshot or GIF, link PR 12
    - _Requirements: 11.5, 13.4_
  - [ ] 13.2 Run the submission checklist, including a clean-clone test with both tenants and a check that `.kiro/` is tracked
    - _Requirements: 11.1, 13.3_
  - [ ] 13.3 Record the demo video (script in `.kiro/steering/submission-checklist.md`). This is not part of the PR diff.
    - _Requirements: 13.4_
