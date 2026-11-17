---
inclusion: fileMatch
fileMatchPattern: "packages/core/**"
---

# Core architecture boundaries (Clean Architecture)

```
packages/core/src/
  domain/          entities, value objects, ports (interfaces), AppError types
  application/     use cases: chat/agent loop, ingestion, retrieval, tool runtime, tenant registry
  infrastructure/  adapters: mongo, redis/bullmq, llm, embeddings, parsers, config loaders
  interfaces/      http (fastify routes, middleware), cli, playground (static files)
  main.api.ts      composition root for the API process
  main.worker.ts   composition root for the worker process
```

## Dependency rule

`domain` <- `application` <- (`infrastructure`, `interfaces`) <- `main.*`.

- `domain` imports nothing outside the language and Zod types if needed. No Node I/O.
- `application` imports only `domain`. It talks to the outside world through ports (`VectorStore`, `ChunkRepository`, `DocumentRepository`, `ConversationRepository`, `JobQueue`, `LlmProvider`, `EmbeddingProvider`, `ToolSource`, `TenantRegistry`, `Clock`, `Logger`).
- `infrastructure` implements ports. It never imports from `interfaces` or `application` internals other than port types in `domain`.
- `interfaces` call `application` use cases. They do not touch Mongo or Redis directly.
- Only `main.*.ts` may instantiate concrete adapters and wire them together.

Third-party packages `mongodb`, `bullmq`, `ioredis`, `fastify`, `openai`-style SDKs, and `pino` must not appear in imports under `domain/` or `application/`. The `arch` script (dependency-cruiser) enforces this; a PreToolUse hook also blocks obvious violations.

## No tenant knowledge in core

Core code must not contain tenant ids, tenant names, tool names, product terms, or prompts that belong to an example tenant. `check:zero-core` greps for example tenant ids and tool names under `packages/core/src`. All domain behavior comes from tenant config.

## Extension points (design for them, do not implement yet)

- `ToolSource` port: `ConfigFileToolSource` (built now) can later be joined by `McpToolSource` and `HttpToolSource` without changing the agent loop.
- `LlmProvider.chat` returns a complete message now. Keep the signature in one place so switching to an async iterator for SSE is a localized change.
- `TenantResolver` strategy: header-based now, JWT/API-key later.
- Usage recording: the agent loop reports token usage through a `UsageRecorder` port (no-op implementation now).

## Public API of the package

`packages/core/src/index.ts` exports only what tenant handlers and tests need: `ToolHandler`, `ToolContext`, `ToolResult`, and test fakes under a separate `@agent-skeleton/core/testing` entry. Everything else is internal.
