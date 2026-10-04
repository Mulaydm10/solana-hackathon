# chain - contract

Solana program `deal_escrow` (Anchor, devnet) + TypeScript client. One template: pay on delivery.

Deal account PDA `["deal", buyer, deal_id u64 LE]`; vault = associated token account owned by the deal PDA.
Status: Funded -> Delivered -> Released | Funded -> Refunded | Delivered -> Claimed.

Instructions (the program, not our server, enforces every rule):
- `create_deal(deal_id, amount, deadline, review_secs, terms_hash)` buyer signs; moves `amount` into the vault. Rejects amount 0, deadline <= now.
- `submit_delivery(delivery_hash)` seller signs; only Funded and only before `deadline`.
- `release()` buyer signs; only Delivered; pays seller.
- `refund()` anyone; only Funded and only after `deadline`; returns funds to buyer.
- `claim()` seller signs; only Delivered and only after `delivered_at + review_secs` (buyer silence = acceptance).

Client (`chain/src/index.ts`): instruction builders for each of the above, `dealAddress(buyer, dealId)`, `fetchDeal(connection, address)`.
Tests run the compiled program (`chain/program/deal_escrow.so`, committed) in LiteSVM, so CI needs no Rust and no network.
Consumed by surface; core never imports chain.
