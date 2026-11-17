# Design: ecommerce-order-concierge

## Layout

```
examples/ecommerce-order-concierge/
  tenant.yaml
  knowledge/
    product-catalog.md
    return-policy.md
    shipping-faq.md
  data/
    orders.json              fictional orders (id, status, carrier, etaDays, deliveredDaysAgo, items)
  tools/
    check-order-status.ts
    request-return.ts
```

## `tenant.yaml` outline

- `id: ecommerce-order-concierge`, `displayName: E-commerce Order Concierge`.
- `systemPrompt`: friendly support agent for a fictional shop; answer from context; use `check_order_status` when the customer provides an order id; confirm order id and reason before `request_return`; explain outcomes using the return policy; never promise refunds beyond the policy.
- `retrieval: { topK: 5, minScore: 0.6 }`, `chunking: { maxTokens: 350, overlap: 40 }`.
- `tools`: `check_order_status` and `request_return` with the schemas from the requirements.

## Handlers

`check-order-status.ts` loads `data/orders.json` relative to the module (resolved with `import.meta.url`) and returns the matching order or `{ ok: false, reason: "order_not_found" }`.

`request-return.ts`:

1. Look up the order. Not found: `order_not_found`.
2. Not `delivered`: `{ ok: false, reason: "not_eligible", detail: "Order has not been delivered yet." }`.
3. Delivered more than 30 days before now: `not_eligible` with the number of days. The handler uses the current time (`Date.now()`); tests fix it with `vi.setSystemTime`. Mock orders store `deliveredDaysAgo` (for example `5`) instead of absolute dates, so the demo does not go stale as time passes.
4. Already has a return in `ctx.data` for this order: `{ ok: false, reason: "already_requested" }`.
5. Otherwise insert `{ returnId: "RET-<n>", orderId, reason, status: "requested", createdAt }` into `returns` and return `{ ok: true, returnId, status, nextSteps }`.

## Mock data design for the demo

| Order | Status | Purpose |
|---|---|---|
| `ORD-1001` | `shipped` | status check with carrier and ETA |
| `ORD-1002` | `delivered`, 5 days ago | eligible return |
| `ORD-1003` | `delivered`, 45 days ago | return rejected (outside window) |
| `ORD-1004` | `processing` | return rejected (not delivered) |

## Knowledge content guidelines

Same as the other tenant. The return policy states the 30-day window, eligible and ineligible conditions, and refund timing, so that the handler rules and the documents agree. Keep both in sync when editing either.
