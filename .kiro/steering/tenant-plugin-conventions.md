---
inclusion: fileMatch
fileMatchPattern: "examples/**"
---

# Tenant plugin conventions

A tenant is a directory. It is the only thing a developer adds to create a new copilot.

```
examples/<tenant-id>/
  tenant.yaml        (or tenant.json)
  knowledge/         *.md, *.markdown, *.pdf
  tools/             one file per tool, default-exporting a handler
  data/              optional mock data used by handlers (JSON)
```

## Rules

- Directory name equals `id` in `tenant.yaml`. Ids match `^[a-z0-9][a-z0-9-]{1,62}$`. A tenant may be a symlink to a directory; the symlink name must equal the id.
- Tool parameter schemas use JSON Schema 2020-12 (omit `$schema` or set it to the 2020-12 URI). The root is `type: object` with `additionalProperties: false`. Unknown keywords and formats are errors.
- Run `npm run validate-tenant -- examples/<tenant-id>` after every change.
- Never edit `packages/core` while working on a tenant. If the core seems to lack something, stop and propose a core change as a separate, explicit task.
- Tenant code imports only types from the public entry `@agent-skeleton/core`. No deep imports into `packages/core/src/...`.
- Tenant code never reads `process.env` for secrets belonging to the core and never opens its own database connections. Persistence goes through `ctx.data`.

## `tenant.yaml` shape

```yaml
id: ops-onboarding-copilot
displayName: Ops Onboarding Copilot
description: One sentence shown in the playground.
systemPrompt: |
  Role, tone, domain rules, when to use which tool.
retrieval:   { topK: 5, minScore: 0.6 }
chunking:    { maxTokens: 400, overlap: 50 }
tools:
  - name: create_it_ticket          # snake_case, unique within the tenant
    description: When and why to call this tool, written for the model.
    handler: ./tools/create-it-ticket   # extensionless; tries .js, .mjs, .ts inside the tenant
    parameters:                         # JSON Schema 2020-12, root must be a closed object
      type: object
      required: [title, priority]
      additionalProperties: false       # required: the model cannot add undeclared arguments
      properties:
        title:    { type: string, maxLength: 200 }
        priority: { type: string, enum: [low, medium, high] }
```

## Tool handler contract

```ts
import type { ToolHandler } from "@agent-skeleton/core";

type Args = { title: string; priority: "low" | "medium" | "high" };

const handler: ToolHandler<Args> = async (args, ctx) => {
  // ctx: { tenantId, sessionId, logger, signal, data }
  return { ticketId: "IT-1042", status: "open" };
};
export default handler;
```

- Return a JSON value (an object is recommended) of at most 16,000 characters of JSON. Returning nothing, or something `JSON.stringify` rejects (`BigInt`, cycles), is an `invalid_result` error. The result is normalized through JSON: dates become ISO strings, `NaN` becomes `null`, a `Map` or `Set` becomes `{}`.
- Return structured outcomes for expected failures (`{ ok: false, reason: "order_not_found" }`) instead of throwing. Throw only for unexpected faults: the model then sees only "the tool failed", and your message goes to the logs.
- Arguments are already validated against `parameters` and are a copy; `ctx.tenantId` and `ctx.sessionId` come from the request, never from arguments.
- Respect `ctx.signal` for long operations. The runtime enforces `TOOL_TIMEOUT_MS` and aborts the signal when it expires. After that, every `ctx.data` operation throws, so a late handler cannot write.
- `ctx.data`: collection names `^[a-z][a-z0-9_-]{0,63}$`; filters are equality on top-level fields with scalar values; top-level keys must not be empty, `__proto__`, start with `$`, or contain `.`; `undefined` is stored as `null`. Test handlers with `InMemoryTenantDataStoreFactory` from `@agent-skeleton/core/testing`, which follows the same rules.
- Keep handlers small and deterministic. Mock data must be clearly fictional.

## Knowledge documents

- Prefer Markdown with meaningful headings. The chunker splits on headings and records the heading path for citations.
- One topic per file, descriptive filenames (they appear in citations).
- Include at least one PDF across the examples so the PDF path is exercised.
- Never include real personal data, real credentials, or real company information.

## System prompt guidance

State the role, the scope boundary ("only answer from the provided context"), and when to call each tool. If a tool changes state (`create_it_ticket`, `request_return`), tell the model to confirm the details with the user first. Do not repeat the core guardrails. The core prepends them.
