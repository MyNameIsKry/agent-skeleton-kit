# Implementation plan: ecommerce-order-concierge

Prerequisite: core-skeleton tasks 1 through 9 complete. No task here edits `packages/core`.

- [ ] 1. Author knowledge and data
  - [ ] 1.1 Write `product-catalog.md`, `return-policy.md`, `shipping-faq.md` (fictional content)
    - _Requirements: 1.1_
  - [ ] 1.2 Write `data/orders.json` with the four demo orders
    - _Requirements: 2.2, 3.3_

- [ ] 2. Tenant config and handlers
  - [ ] 2.1 Write `tenant.yaml` (prompt, retrieval, chunking, two tool schemas)
    - _Requirements: 2.1, 3.1, 3.2_
  - [ ] 2.2 Implement `tools/check-order-status.ts`
    - _Requirements: 2.2, 2.3_
  - [ ] 2.3 Implement `tools/request-return.ts` with eligibility rules
    - _Requirements: 3.3, 3.4_
  - [ ] 2.4 Handler unit tests: found, not found, eligible, outside window, not delivered, duplicate request
    - _Requirements: 2.3, 3.3, 3.4_

- [ ] 3. Verification
  - [ ] 3.1 `validate-tenant` passes
    - _Requirements: 4.1_
  - [ ] 3.2 Manual run: return policy question with citation, status of `ORD-1001`, eligible return for `ORD-1002`, rejected return for `ORD-1003`
    - _Requirements: 1.2, 2.2, 3.5_
  - [ ] 3.3 Manual run: ask about HR policy, expect "no information" and no ticket offer
    - _Requirements: 4.3_
  - [ ] 3.4 Confirm `git diff --stat` of the adding commit shows nothing under `packages/core`, and run `check:zero-core`
    - _Requirements: 4.2_
