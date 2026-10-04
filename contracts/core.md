# core - contract

Procurement layer, chain-agnostic. No network, chain SDK, clock or `process.env`: time enters as `now` (unix seconds).

Exposes (`core/src/index.ts`):
- `DealTerms` = { template: "pay_on_delivery", buyer, seller, serviceId, task, price: bigint (token base units), deadline: number (unix s), reviewSecs: number }
- `validateTerms(terms, { now, budgetRemaining, maxDeadlineSecs? }) -> { ok: true, value } | { ok: false, reason }`
  reason = UNKNOWN_TEMPLATE | ZERO_PRICE | OVER_BUDGET | DEADLINE_IN_PAST | DEADLINE_TOO_FAR | SELF_DEAL | BAD_REVIEW_WINDOW
- `termsHash(terms) -> Uint8Array(32)`: sha256 of canonical JSON (sorted keys, bigint as decimal string). Stored on chain at lock.
- `describeTerms(terms, { decimals, symbol }) -> string`: the plain-language summary the buyer approves.
- Refusals are values, never throws.
