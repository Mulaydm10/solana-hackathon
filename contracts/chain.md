# chain - contract

Solana program `deal_escrow` (Anchor 1.x, devnet `CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV`) plus its TypeScript
client and library. The program, not any server, enforces every rule below. Full design: `docs/PLAN.md` §2.

## Accounts (PDAs)

| Account | Seeds | What |
|---|---|---|
| `BuyerPolicy` | `["policy", buyer]` | Period budget, max price, seller allowlist (fail closed), approver above a threshold |
| `Deal` + vault ATA | `["deal", buyer, deal_id]` | The escrow. Layout unchanged since v2 |
| `SellerRep` | `["rep", seller, mint]` | completed / failed / neutral, volume, distinct buyers, max pair volume, per mint |
| `RepPair` | `["rep", seller, buyer, mint]` | History between one seller and one buyer |
| `AssessorRegistry` | `["assessors"]` | Assessors whose attestations count; set only by the program's upgrade authority |
| `Listing` | `["listing", seller, listing_id]` | Data / Service / Team, content + meta + terms hashes, assessor, report, active, sales |
| `DealLink` | `["link", deal]` | Listing, expected delivery hash (Data), listing incarnation |
| `Mission` + vault | `["mission", buyer, mission_id]`, authority `["mission_auth", mission]` | Budget, stages, mandate digest, the buyer's deal floors |
| `Mandate` | `["mandate", mission, agent]` | Cap, per-payment cap, payees, stage mask, expiry, revoked |
| `MissionDeal` | `["mission_deal", deal]` | Which agent opened a mission deal |

## Deals

Statuses: Open, Funded, Delivered, Challenged, Released, Claimed, Refunded, Cancelled, VerifiedPass, VerifiedFail,
NoVerdict. Every payout goes through one `settle()` with a conservation check; it is also the only writer of
reputation and listing sales.

- `create_deal`: buyer. Checked against the policy. An optional listing must be active, attested by a
  **registered** assessor, and match seller, mint, price and the **content hash the buyer saw**.
- `accept` (seller stakes), `submit_delivery` (hash + invoice within tolerance; a Data deal must deliver the
  listed content), `release` (buyer names the delivered hash), `claim` (anyone after review), `challenge` (buyer,
  with a bond, needs a verifier), `resolve` (verifier), `timeout_refund`, `refund`, `cancel`.

## Listings

`set_assessors` (upgrade authority, proven from this program's ProgramData header), `create_listing`,
`attest_listing` (the listing's assessor, bound to the content hash it saw), `update_listing` (new content or
metadata clears the attestation), `close_listing` (open deals keep working through their `DealLink`).

## Missions (hired agent teams)

`create_mission` (charged to the buyer's policy; the buyer fixes the **verifier, minimum review/resolve windows and
maximum tolerance** for every agent deal), `add_mandate` (before the first approval; running digest),
`approve_stage` (names the digest; in order; approver above the threshold), `agent_spend`, `agent_open_deal`
(re-enters `create_deal` as the mission authority; refuses weaker terms), `agent_release` / `agent_challenge` (the
buyer at any time, or **only the agent that opened the deal**), `revoke_mandate`, `close_mission` (repeatable sweep).
Every token an agent moves counts against per-payment, mandate, stage and mission caps; refunds never reduce `spent`.

## Known limits (stated, by design)

- If the upgrade authority is ever removed, `set_assessors` can never run again: the registry freezes. Never remove
  it without Dhruv's explicit OK (PLAN §13).
- A mission's authority copies the buyer's allowlist and max price at `create_mission`. Later policy changes do not
  reach that mission's agent deals; revoking or closing does.
- `close_mission` credits the unspent budget back to the buyer's period once. Refunds swept later return as tokens
  but stay counted as spent for that period (conservative).
- An agent's `agent_release` / `agent_challenge` needs a live mandate with the **current** stage open for it; a deal
  opened in an earlier stage is acted on by the buyer once that stage has passed (the orchestrator routes late
  deliveries to the buyer).
- The buyer also bounds the challenge bond (`max_bond_bps`) and the seller's minimum stake (`min_stake_bps`) of
  agents' deals (#103).
- `Listing.sales` can be under-counted (the listing account is optional at settlement) but never inflated; it must
  not feed ranking or pricing.

## Client and library (`chain/src`, browser-safe)

- Generated Codama client (`npm run codegen`). `create_deal`'s link/registry and agent actions' mandate/registry are
  not defaulted.
- `deals.*` (deals.ts), `listings.*` and `missions.*` (market.ts): every action goes through `safeSend` (chain state
  is checked after any non-program error; nothing is sent twice) and returns `{ ok: true, signature }` or
  `{ ok: false, reason, message }` with the program's error names.
- Views: `getDeal`, `getPolicy`, `getSellerRep`, `getRepPair`, `getListing`, `getMission`, `getMandate`;
  `mandatesDigest` mirrors the program's digest so a UI binds an approval to what it showed.

## Proof

Tests run the committed program (`chain/program/deal_escrow.so`) in LiteSVM: unit tests per instruction and refusal,
plus two randomized attack searches (deals; missions) checked against independent models after every step.
`chain/scripts/verify-deployed.ts` compares the deployed program with the committed binary;
`DEAL_CHECK_DEVNET=1 npm test --prefix chain` runs the devnet proof.
