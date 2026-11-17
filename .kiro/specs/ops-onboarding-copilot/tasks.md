# Implementation plan: ops-onboarding-copilot

Prerequisite: core-skeleton PRs 1 through 10 merged. These tasks ship in core-skeleton PR 11 together with `check:zero-core`. No task here edits `packages/core`.

- [ ] 1. Author knowledge documents
  - [ ] 1.1 Write `engineering-handbook.md`, `hr-policies.md`, `it-troubleshooting.md` (fictional content)
    - _Requirements: 1.1, 1.2_
  - [ ] 1.2 Add `new-hire-checklist.pdf` (small static PDF)
    - _Requirements: 1.2_

- [ ] 2. Tenant config and handler
  - [ ] 2.1 Write `tenant.yaml` (prompt, retrieval, chunking, tool schema)
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [ ] 2.2 Implement `tools/create-it-ticket.ts`
    - _Requirements: 2.4_
  - [ ] 2.3 Handler unit test with the in-memory `TenantDataStore` fake
    - _Requirements: 2.4_

- [ ] 3. Verification
  - [ ] 3.1 `validate-tenant` passes
    - _Requirements: 3.1_
  - [ ] 3.2 Manual run in the playground: policy question with citation, unresolved VPN issue, confirmed ticket creation
    - _Requirements: 1.3, 2.2, 2.3_
  - [ ] 3.3 Manual run: e-commerce question gets "no information"
    - _Requirements: 3.3_
  - [ ] 3.4 Run `check:zero-core`
    - _Requirements: 3.2_
