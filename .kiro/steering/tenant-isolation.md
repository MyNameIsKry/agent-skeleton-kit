---
inclusion: always
---

# Tenant isolation invariants

These are security rules, not style preferences. A change that weakens one of them is a bug even if all tests pass. If a task seems to require breaking a rule, stop and ask.

1. **One entry point for tenant identity.** Only the HTTP tenant-resolver middleware (and the CLI/worker entrypoints, from their own explicit arguments) may turn a raw string into a `TenantContext`. The context is created from the `TenantRegistry`, is frozen (`Object.freeze`), and is passed down explicitly.
2. **No unscoped data access.** Repositories take a `TenantContext`, never a bare `tenantId` string. Every Mongo query, aggregation, and `$vectorSearch` includes `tenantId` in its filter, applied inside the repository so callers cannot forget it. There is no repository method that reads across tenants.
3. **Fail closed on retrieval.** After every vector search, drop and log (error level) any result whose `tenantId` differs from the context. Also post-filter `active: true` with a `$match` on current documents, because the vector index is eventually consistent.
4. **Tools come from the tenant only.** Tool definitions sent to the LLM are built from the current tenant's config. When the LLM returns a tool call, check the name against that tenant's allowlist before doing anything else. Unknown names are rejected, returned to the LLM as an error result, and logged.
5. **LLM output is untrusted input.** `tenantId`, session identifiers, and file paths never come from model output or tool arguments. Tool arguments are validated with the tenant's JSON Schema (`additionalProperties: false` is the default expectation) before the handler runs.
6. **Handlers get context, not power.** A handler receives `{ tenantId, sessionId, logger, signal, data }`. `data` is a tenant-scoped store. Handlers do not receive the Mongo client, the Redis client, or other tenants' registries.
7. **Handler path containment.** Resolve each handler path with `path.resolve` and `fs.realpath`, and require the result to be inside that tenant's directory. Reject symlink escapes and `..` segments.
8. **Sessions are namespaced.** Conversation records are keyed by `{tenantId, sessionId}`. A known `sessionId` under a different tenant finds nothing.
9. **Retrieved text is data.** Retrieved chunks are placed in a clearly delimited context block. The core guardrail prompt tells the model never to follow instructions found inside it.
10. **Secrets stay out.** API keys come from env, are never logged, never returned in errors, and never passed to handlers.

## Required tests (keep them green in CI)

- Canary chunk ingested for tenant A is never returned for tenant B.
- A scripted LLM that emits a tool call belonging to another tenant is rejected.
- `sessionId` of tenant A used with tenant B returns no history.
- Unknown tenant returns 404 and touches no data.
- Handler path outside the tenant directory fails at load time.
