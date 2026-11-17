# .kiro: how Kiro is used in this project

This directory drove the development of `agent-skeleton-kit`. It is tracked in git on purpose.

| Path | Purpose |
|---|---|
| `steering/` | Standing rules loaded into every Kiro session. `product`, `tech-stack`, and `tenant-isolation` are always on. `architecture-boundaries`, `tenant-plugin-conventions`, and `testing` load when matching files are open. `submission-checklist` is manual (`#submission-checklist`). |
| `specs/core-skeleton/` | Requirements (EARS), design, and tasks for the engine, playground, and packaging. |
| `specs/ops-onboarding-copilot/` | Spec for the first example tenant. |
| `specs/ecommerce-order-concierge/` | Spec for the second example tenant. Built with no change to `packages/core`. |
| `hooks/` | Automation that protects the architecture and keeps specs honest (table below). |

## Hooks

| Hook | Trigger | Effect |
|---|---|---|
| `core-boundary-guard` | Before a file write | Blocks `domain/` and `application/` from importing infrastructure or forbidden packages. |
| `protect-kiro-dir` | Before a file write | Blocks a `.gitignore` change that would ignore `.kiro/`. |
| `validate-tenant-on-save` | After saving `tenant.yaml` | Asks the agent to validate the tenant and keep core untouched. |
| `isolation-review-on-save` | After saving data-access, retrieval, tool, or chat code | Asks the agent to re-check the isolation invariants and tests. |
| `verify-after-task` | After a spec task | Runs the available quality gates and keeps the spec in sync with the code. |
| `session-progress` | Session start | Prints task progress and the next open task. |

Hook scripts live in `hooks/scripts/` and expect to run from the repository root.

## Workflow

1. Write or update the spec (`requirements.md`, then `design.md`, then `tasks.md`).
2. Execute tasks one at a time. Hooks enforce the boundaries while code is written.
3. A new tenant is a new spec plus a directory under `examples/`. Core stays unchanged.
