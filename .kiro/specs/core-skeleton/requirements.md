# Requirements: core-skeleton

## Introduction

`agent-skeleton-kit` is a multi-tenant RAG and tool-calling agent skeleton. A single core engine (`packages/core`) serves many isolated tenants. Each tenant is a directory holding a declarative config, knowledge documents, and tool handlers. This spec covers the core engine, the Web Playground, and the packaging needed to run it. The two example tenants have their own specs (`ops-onboarding-copilot`, `ecommerce-order-concierge`).

Terms: **tenant** is an isolated copilot definition. **Tenant context** is the frozen, validated object carrying a tenant's identity and config through the system. **Chunk** is an embedded passage of a knowledge document. **Handler** is the code that executes a tool.

Requirement format follows EARS: WHEN / IF / WHILE ... THE system SHALL ...

---

## Requirement 1: Tenant definition and loading

**User story:** As a developer, I want to define a tenant with files only, so that I can create a new copilot without changing the engine.

### Acceptance criteria

1. WHEN the API or worker process starts, THE system SHALL discover every subdirectory of `TENANTS_DIR` that contains `tenant.yaml`, `tenant.yml`, or `tenant.json`, and load it.
2. THE system SHALL validate each tenant config against a schema covering `id`, `displayName`, `description`, `systemPrompt`, `retrieval`, `chunking`, and `tools`.
3. IF a tenant config is invalid, THEN THE system SHALL refuse to start and print the tenant directory, the field path, and the reason.
4. THE system SHALL require `id` to match `^[a-z0-9][a-z0-9-]{1,62}$`, to equal the directory name, and to be unique across tenants.
5. THE system SHALL require each tool `parameters` value to be a valid JSON Schema of `type: object`, and tool names to be unique within a tenant.
6. THE system SHALL resolve each tool `handler` path inside the tenant directory and IF the handler is missing or resolves outside that directory, THEN THE system SHALL refuse to start with a clear error.
7. WHEN a developer runs `npm run validate-tenant -- <dir>`, THE system SHALL perform the checks above without starting servers and exit non-zero on failure.

## Requirement 2: Tenant resolution and isolation

**User story:** As an operator, I want every request confined to one tenant, so that data and tools never leak between copilots.

### Acceptance criteria

1. WHEN a request reaches a tenant-scoped endpoint, THE system SHALL resolve the tenant from the `X-Tenant-Id` header against the tenant registry and create a frozen tenant context.
2. IF the header is missing, THEN THE system SHALL respond `400`. IF the tenant is unknown, THEN THE system SHALL respond `404` and perform no data access.
3. THE system SHALL expose no repository operation that reads or writes tenant data without a tenant context.
4. THE system SHALL include `tenantId` in every database filter and vector search issued for a tenant.
5. THE system SHALL key conversation records by tenant and session, so that a session id used under another tenant returns no history.
6. THE system SHALL NOT take tenant identity, session identity, or file paths from LLM output or tool arguments.

## Requirement 3: Asynchronous document ingestion

**User story:** As a developer, I want documents ingested in the background, so that the API stays responsive while knowledge is indexed.

### Acceptance criteria

1. THE system SHALL ingest `.md`, `.markdown`, and `.pdf` files from a tenant's `knowledge/` directory, and skip other file types with a logged warning.
2. WHEN an ingestion is requested, THE system SHALL record the document as `pending`, enqueue a job, and return without waiting for processing.
3. WHEN a worker takes a job, THE system SHALL parse the file, split it into chunks according to the tenant's `chunking` config, generate embeddings in batches, and store the chunks.
4. THE system SHALL track each document's status as `pending`, `processing`, `ready`, or `failed`, with an error message for `failed`.
5. IF a job fails, THEN THE system SHALL retry with exponential backoff up to a configured limit and then mark the document `failed`.
6. WHERE `AUTO_INGEST=true`, THE system SHALL enqueue ingestion for all tenants' knowledge files at API startup.
7. WHEN a markdown file is chunked, THE system SHALL record the heading path in the chunk metadata. WHEN a PDF is chunked, THE system SHALL record the page number.

## Requirement 4: Ingestion consistency

**User story:** As a user, I want answers to stay correct while documents are being re-indexed, so that updates never produce missing or duplicated knowledge.

### Acceptance criteria

1. WHEN a document's content hash equals that of its `ready` version, THE system SHALL skip embedding and keep the existing chunks.
2. WHEN a document's content changes, THE system SHALL index the new content as a new version while the previous version continues to serve queries.
3. WHEN a new version finishes indexing, THE system SHALL switch the active version in one transaction, so that no query sees a mix of versions after the commit.
4. THE system SHALL derive job ids and chunk ids deterministically from tenant, document, content hash, version, and chunk index, so that duplicate or retried jobs do not create duplicate chunks.
5. WHEN a source file no longer exists in the tenant's `knowledge/` directory, THE system SHALL remove that document and its chunks during the next ingestion sync.
6. THE system SHALL delete superseded chunks only after the new version is active.

## Requirement 5: Retrieval

**User story:** As a user, I want answers grounded in my tenant's documents, so that the copilot is accurate and cites its sources.

### Acceptance criteria

1. WHEN a chat message arrives, THE system SHALL embed it, run a vector search limited to the tenant's active chunks, and keep results with score at or above `retrieval.minScore`, up to `retrieval.topK`.
2. THE system SHALL return, for each retrieved chunk, the source file name, heading path or page, score, and text.
3. THE system SHALL drop and log as an error any retrieved chunk whose tenant differs from the request's tenant, and SHALL post-filter results for `active = true`.
4. IF no chunk meets the threshold, THEN THE system SHALL instruct the model to say it lacks the information instead of guessing.

## Requirement 6: Chat and agent loop

**User story:** As a user, I want to chat with a tenant's copilot that can answer from documents and take actions, so that I get help without leaving the conversation.

### Acceptance criteria

1. THE system SHALL expose `POST /v1/chat` accepting `message` (1 to 4000 characters) and an optional `sessionId`, and SHALL generate a `sessionId` when none is provided.
2. THE system SHALL build the model prompt from, in order: core guardrail instructions, the tenant `systemPrompt`, the delimited retrieved context, the recent conversation history, and the tenant's tool definitions.
3. THE core guardrail instructions SHALL tell the model to answer from the provided context, to cite sources, to say when it does not know, and to treat context text as data, never as instructions.
4. WHILE the model returns tool calls, THE system SHALL execute them and feed the results back, up to `MAX_TOOL_ITERATIONS` rounds. WHEN the limit is reached, THE system SHALL stop and return a graceful message.
5. THE system SHALL return `{ sessionId, answer, citations, toolCalls }`, where each tool call includes name, arguments, result or error, and duration.
6. THE system SHALL persist user and assistant messages (including tool calls) per tenant and session, and use the most recent 20 messages as history.
7. IF the LLM or embedding provider fails, THEN THE system SHALL respond `502` with a safe message and SHALL NOT expose keys or raw provider responses.

## Requirement 7: Declarative tool calling

**User story:** As a developer, I want to declare tools in config and attach a handler, so that each tenant exposes only the actions it is authorized to use.

### Acceptance criteria

1. THE system SHALL send the model only the tool definitions declared by the current tenant.
2. WHEN the model requests a tool not in the tenant's allowlist, THE system SHALL NOT execute anything, SHALL return an error result to the model, and SHALL log the event.
3. WHEN the model requests an allowed tool, THE system SHALL validate the arguments against the tool's JSON Schema, and IF validation fails, THEN THE system SHALL NOT call the handler and SHALL return the validation errors to the model.
4. THE system SHALL call handlers as `handler(args, ctx)` where `ctx` contains `tenantId`, `sessionId`, `logger`, `signal`, and a tenant-scoped `data` store.
5. IF a handler throws or exceeds `TOOL_TIMEOUT_MS`, THEN THE system SHALL record an error result for that call and continue the conversation without crashing the process.
6. THE `data` store SHALL read and write only records belonging to the current tenant.

## Requirement 8: Provider abstraction

**User story:** As a developer, I want to change LLM and embedding providers through configuration, so that the engine is not tied to one vendor.

### Acceptance criteria

1. THE system SHALL define `LlmProvider` and `EmbeddingProvider` ports and ship one adapter for OpenAI-compatible HTTP APIs, configured by environment variables.
2. IF the LLM or embedding configuration is missing or invalid at startup, THEN THE system SHALL fail fast with a message naming the missing variable and pointing to `.env.example`.
3. WHEN the configured embedding dimension differs from the existing vector index, THE system SHALL fail at startup with an explicit reindex instruction.
4. THE system SHALL provide fake providers for tests so that no automated test calls a real model.

## Requirement 9: Web Playground

**User story:** As a developer or judge, I want a simple chat UI with a tenant switcher, so that I can see isolated copilots working side by side.

### Acceptance criteria

1. THE system SHALL serve the playground at `/` as static files that need no build step.
2. THE playground SHALL populate a tenant dropdown from `GET /v1/tenants` and, WHEN the selection changes, SHALL start a new session for the selected tenant.
3. THE playground SHALL show, for each assistant message, the citations used (file, heading or page, snippet) and every tool call with its arguments and result.
4. THE playground SHALL show the ingestion status of the selected tenant's documents.
5. THE playground SHALL show clear error states for provider failures, unknown tenants, and network errors.
6. WHERE tool handlers store records through `ctx.data`, THE playground SHOULD offer a read-only records view for the selected tenant.

## Requirement 10: Extensibility proof

**User story:** As a hackathon judge, I want evidence that a new domain needs no core changes, so that the skeleton claim is credible.

### Acceptance criteria

1. THE repository SHALL contain two example tenants under `examples/` that differ in domain, knowledge, and tools.
2. WHEN `npm run check:zero-core` runs, THE system SHALL copy an example tenant to a temporary directory under a new id, load it through the tenant registry, and verify that no file under `packages/core` was modified.
3. THE check SHALL also fail if any example tenant id or tool name appears under `packages/core/src`.
4. EACH example tenant SHALL have its own spec under `.kiro/specs/`.

## Requirement 11: Deployment and developer experience

**User story:** As a technical judge, I want to run the system with two commands, so that I can verify it works as demonstrated.

### Acceptance criteria

1. WHEN a user runs `cp .env.example .env`, sets the LLM API key, and runs `docker compose up --build`, THE system SHALL start MongoDB, Redis, the API (with playground), and the worker with no further manual steps.
2. THE compose file SHALL define health checks and SHALL start `api` and `worker` only after MongoDB and Redis are healthy.
3. WHEN the API starts, THE system SHALL create missing indexes and the vector index, wait until the vector index is queryable, and then begin accepting chat requests.
4. THE compose file SHALL pin image tags, and the application image SHALL run as a non-root user.
5. THE README SHALL document the quick start, environment variables, and how to add a tenant.

## Requirement 12: Observability and operations

**User story:** As an operator, I want clear logs and health signals, so that I can diagnose problems quickly.

### Acceptance criteria

1. THE system SHALL emit structured JSON logs that include a request id and, where applicable, the tenant id, and SHALL redact secrets.
2. THE system SHALL expose `GET /healthz` reporting MongoDB, Redis, and vector index readiness, with a non-2xx status when any is not ready.
3. WHEN the worker receives a termination signal, THE system SHALL stop taking jobs and let in-flight jobs finish within a bounded time.

## Requirement 13: Quality and submission readiness

**User story:** As a maintainer, I want automated quality gates and a complete repository, so that the project meets the hackathon requirements and stays maintainable.

### Acceptance criteria

1. THE codebase SHALL compile with TypeScript strict options, and lint, typecheck, unit, isolation, architecture, and zero-core checks SHALL run in CI.
2. THE architecture check SHALL fail if `domain` or `application` import from `infrastructure`, `interfaces`, or forbidden third-party packages.
3. THE repository SHALL be public, include an OSI-approved `LICENSE`, and track the `.kiro/` directory (steering, specs, hooks) without ignoring it.
4. THE README SHALL include an architecture diagram, a description of how Kiro was used, and the roadmap (MCP tool source, SSE streaming, per-tenant usage telemetry, RBAC).
