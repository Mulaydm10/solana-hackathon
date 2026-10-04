# surface - contract

Web demo + HTTP API for the procurement flow: Ask -> Find -> Draft terms -> Lock -> Deliver -> Settle.

- `GET /api/services` hard-coded service catalog (id, name, seller pubkey, price, typical turnaround).
- `POST /api/draft { request }` -> { options[], terms, summary }. Claude turns the request into terms; a rule-based fallback is used when no `ANTHROPIC_API_KEY` is set. The AI only fills in a template; it never writes program code.
- `POST /api/lock { terms }` -> validates with core, sends `create_deal` on devnet, returns { dealAddress, signature }.
- `POST /api/deals/:address/deliver | release | refund | claim` -> signature. Demo server holds devnet buyer/seller keys.
- `GET /api/deals/:address` -> on-chain deal state.
- Refusals (core reasons or program errors) are normal JSON results with a reason code, not 500s.
Depends on: core (terms), chain (program client).
