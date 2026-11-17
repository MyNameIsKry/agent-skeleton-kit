---
inclusion: always
---

# Product: agent-skeleton-kit

A multi-tenant RAG and tool-calling agent skeleton. One shared engine (`packages/core`) runs many isolated, domain-specific AI copilots. A new copilot is created by adding a tenant directory (declarative config, knowledge documents, tool handlers). Nothing under `packages/core` changes.

Hackathon: Kiroween 2026, category **Skeleton Crew** (a lean, flexible template shown through two distinct applications built on the same foundation).

## Goals

1. **Zero-core-modification extensibility.** Adding a tenant never edits `packages/core`. This is the headline claim and it must be provable by an automated check.
2. **Strict tenant isolation.** Knowledge, system prompts, tools, and conversation history never cross tenant boundaries.
3. **One-command run.** `cp .env.example .env`, set the LLM API key, `docker compose up --build`. Nothing else.
4. **Legible demo.** The Web Playground exposes what happens inside: retrieved citations, tool calls with arguments and results, ingestion status.

## Two example tenants (`examples/`)

| Tenant | Knowledge | Tools |
|---|---|---|
| `ops-onboarding-copilot` | Engineering and HR policies, IT troubleshooting | `create_it_ticket(title, priority)` |
| `ecommerce-order-concierge` | Product catalog, return policy, shipping FAQ | `check_order_status(order_id)`, `request_return(order_id, reason)` |

## Non-goals for this iteration

Streaming (SSE), MCP tool sources, RBAC and real authentication, per-tenant token telemetry, local-model (Ollama) adapter. These are roadmap items. Design extension points for them (see `design.md`) but do not build them.

## Quality bar (how the project is judged)

Three equally weighted criteria: Potential Value, Implementation (depth and variety of Kiro use), Quality and Design. Therefore:

- Keep `.kiro/` (steering, specs, hooks) accurate and tracked in git. Never add `.kiro` to `.gitignore`.
- Update specs when the design changes. Specs describe what was actually built.
- Prefer a small, polished, verifiably working feature over a broad, unfinished one.

## Language policy

All code, comments, docs, specs, commit messages, and UI strings are in English.
