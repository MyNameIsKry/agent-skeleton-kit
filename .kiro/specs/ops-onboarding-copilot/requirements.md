# Requirements: ops-onboarding-copilot

## Introduction

An example tenant that helps new employees with engineering and HR onboarding questions and files IT tickets when self-service troubleshooting is not enough. It is built only from files under `examples/ops-onboarding-copilot/`. No change to `packages/core` is allowed.

All people, systems, and policies in the knowledge documents are fictional.

## Requirement 1: Onboarding knowledge

**User story:** As a new employee, I want answers about policies and setup steps, so that I can get productive without asking colleagues.

### Acceptance criteria

1. THE tenant SHALL include knowledge documents covering: engineering handbook (repo access, code review, on-call basics), HR policies (leave, working hours, equipment), and IT troubleshooting (VPN, password reset, laptop setup, access requests).
2. THE knowledge set SHALL include at least one PDF document and several Markdown documents with meaningful headings.
3. WHEN a question is answered from the documents, THE copilot SHALL cite the source file.
4. IF the documents do not contain the answer, THEN THE copilot SHALL say so and suggest contacting the relevant team.

## Requirement 2: IT ticket creation

**User story:** As a new employee, I want the copilot to open an IT ticket when troubleshooting fails, so that I get human help.

### Acceptance criteria

1. THE tenant SHALL declare the tool `create_it_ticket(title, priority)` with `title` a string of at most 200 characters and `priority` one of `low`, `medium`, `high`, and `additionalProperties: false`.
2. WHEN the documented troubleshooting steps have been offered and the issue remains unresolved, THE copilot SHALL propose opening a ticket and show the title and priority to the user.
3. THE copilot SHALL call `create_it_ticket` only after the user confirms.
4. WHEN the tool runs, THE handler SHALL store the ticket through `ctx.data` with a sequential id (`IT-<number>`), status `open`, and a creation timestamp, and SHALL return `{ ticketId, status, title, priority }`.
5. THE tenant SHALL expose no other tools.

## Requirement 3: Extensibility evidence

### Acceptance criteria

1. THE tenant SHALL pass `npm run validate-tenant -- examples/ops-onboarding-copilot`.
2. THE addition of this tenant SHALL leave `npm run check:zero-core` passing, with no change under `packages/core`.
3. WHEN a user asks about an e-commerce topic (orders, returns), THE copilot SHALL state that it has no such information, because the tenant has neither the knowledge nor the tools.
