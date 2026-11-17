# Requirements: ecommerce-order-concierge

## Introduction

An example tenant that answers shop customers' questions about products, shipping, and returns, and acts on orders through two tools. It is built only from files under `examples/ecommerce-order-concierge/`. No change to `packages/core` is allowed. It demonstrates that a different domain with different tools runs on the same engine.

All products, customers, and orders are fictional.

## Requirement 1: Store knowledge

**User story:** As a shopper, I want answers about products, shipping, and returns, so that I can decide and act quickly.

### Acceptance criteria

1. THE tenant SHALL include knowledge documents covering a product catalog, the return policy (return window, eligible conditions, refund timing), and a shipping FAQ.
2. WHEN a question is answered from the documents, THE copilot SHALL cite the source file.
3. IF the documents do not contain the answer, THEN THE copilot SHALL say so and not invent product details or policies.

## Requirement 2: Order status

**User story:** As a shopper, I want to check my order status in chat, so that I do not have to search my email.

### Acceptance criteria

1. THE tenant SHALL declare `check_order_status(order_id)` where `order_id` is a string matching `^ORD-[0-9]{4}$`, with `additionalProperties: false`.
2. WHEN the user gives an order id and asks about the order, THE copilot SHALL call the tool and report status, carrier, and estimated delivery when present.
3. IF the order id does not exist, THEN THE handler SHALL return `{ ok: false, reason: "order_not_found" }` and THE copilot SHALL ask the user to double-check the id.

## Requirement 3: Return requests

**User story:** As a shopper, I want to start a return from chat, so that I get a clear next step.

### Acceptance criteria

1. THE tenant SHALL declare `request_return(order_id, reason)` where `order_id` follows the same pattern and `reason` is a string of 5 to 500 characters.
2. THE copilot SHALL confirm the order id and reason with the user before calling `request_return`.
3. THE handler SHALL verify the order exists, has status `delivered`, and was delivered within the return window defined in the return policy (30 days). Otherwise it SHALL return `{ ok: false, reason: "not_eligible", detail }` without creating a record.
4. WHEN the order is eligible, THE handler SHALL store a return record through `ctx.data` with id `RET-<number>`, status `requested`, and a timestamp, and SHALL return `{ ok: true, returnId, status, nextSteps }`.
5. THE copilot SHALL explain the outcome using the return policy.

## Requirement 4: Extensibility and isolation evidence

### Acceptance criteria

1. THE tenant SHALL pass `npm run validate-tenant -- examples/ecommerce-order-concierge`.
2. THE commit that adds this tenant SHALL show no changes under `packages/core`.
3. WHEN asked about internal engineering or HR policies, THE copilot SHALL state it has no such information, and SHALL NOT offer `create_it_ticket`.
