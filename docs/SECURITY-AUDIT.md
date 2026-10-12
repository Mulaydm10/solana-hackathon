# Security and audit readiness

> **Status (12 Oct 2026):** Solana devnet only, test USDC, **not externally audited**.
> This page is the brief for an auditor: what to review, who can do what, what must always hold,
> the evidence so far, and the open items we already know about.
> How the program is built (code map, diagrams): [`PROGRAM-ARCHITECTURE.md`](PROGRAM-ARCHITECTURE.md).
> To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## At a glance

| | |
|---|---|
| Program | `deal_escrow`, Anchor (anchor-lang 1.2.0), Rust 1.89.0 |
| Source | [`chain/anchor/programs/deal_escrow/src/lib.rs`](../chain/anchor/programs/deal_escrow/src/lib.rs): one file, 1,979 lines (1,672 without blank and comment lines) |
| Surface | 26 instructions · 10 account types · 2 events · 56 error codes |
| Devnet program | [`CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV`](https://explorer.solana.com/address/CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV?cluster=devnet) |
| Upgrade authority (devnet) | `FggjxE5Qqg6B842PjZsXJK9HASppZdkfVyWfYFtHHAjn`, a single key (open item 2) |
| Source last changed | commit `4b98dd9` (4 Oct 2026), deployed in slot 507459446 |
| Build fingerprint | sha256 `d437551261d8a438b41b9e0ecc60994ccc9db4df3cfbeab322b226c31b1f7e8c`: a build from this source, the committed binary and the deployed program are byte-for-byte identical |
| Tests | 97 program tests, all passing; randomized, model-checked attack search with 0 invariant violations in 2,000 runs |

## Scope

### In scope: the program

| Area | Instructions | What it guards |
|---|---|---|
| Buyer policy | `init_policy`, `update_policy` | Budget per period, max price, seller allowlist, a second approver above a threshold |
| Escrow deals | `create_deal`, `cancel`, `accept`, `submit_delivery`, `release`, `claim`, `challenge`, `resolve`, `timeout_refund`, `refund` | The order, the seller's stake and the buyer's bond, held in a per-deal vault until one settle path pays out |
| Listings and assessors | `set_assessors`, `create_listing`, `attest_listing`, `update_listing`, `close_listing` | What is sold (content hash) and who may attest it; a Data listing must be delivered with exactly its content hash |
| Missions and mandates | `create_mission`, `add_mandate`, `approve_stage`, `agent_spend`, `agent_open_deal`, `agent_release`, `agent_challenge`, `revoke_mandate`, `close_mission` | A mission budget that agents spend only within their caps, payees, approved stages and expiry |

### Accounts

| Account | Address | Holds |
|---|---|---|
| `BuyerPolicy` | PDA `["policy", buyer]` | The buyer's limits (each mission authority has one too) |
| `Deal` | PDA `["deal", buyer, deal_id]` | Terms, status, amounts posted, windows, verifier |
| Deal vault | ATA(mint, `Deal` PDA) | Order + stake + bond |
| `Listing` | PDA `["listing", seller, listing_id]` | Content hash, price, mint, assessor attestation |
| `DealLink` | PDA `["link", deal]` | Binds a deal to the listing content the buyer saw |
| `AssessorRegistry` | PDA `["assessors"]` | Assessors whose attestations count |
| `Mission` | PDA `["mission", buyer, mission_id]` | Budget, spent, stages, approver, expiry |
| Mission authority | PDA `["mission_auth", mission]` | Signer for the mission vault and the mission's deals (no data) |
| Mission vault | ATA(mint, mission authority) | The unspent mission budget |
| `Mandate` | PDA `["mandate", mission, agent]` | One agent's caps, payees, stage bits, expiry, revoked flag |
| `MissionDeal` | PDA `["mission_deal", deal]` | Which agent opened a mission deal |
| `SellerRep`, `RepPair` | PDAs `["rep", seller, mint]`, `["rep", seller, buyer, mint]` | Reputation counts, written only when a deal settles |

Ids are `u64`, little-endian. Events: `DealEvent` (status changes) and `SpendEvent` (agent spends).

### Out of scope for the program audit, but part of the trust model

The off-chain code that holds role keys: the agent runtime and mission service ([`agents/`](../agents)), the MCP server ([`mcp/`](../mcp)) and the web app ([`web/`](../web)). They can only do what their keys are allowed to do on chain (see *Roles*). The signing path that guarantees a payment is sent once ([`chain/src`](../chain/src): `safeSend`, `exactlyOnce`) would be a useful second review.

## Where the money is

- **Deal vaults.** Each deal has its own vault, an associated token account owned by the deal's PDA, holding the order, the seller's stake and the buyer's bond. Tokens leave it only in `settle`, after every check, and only to the deal's own buyer and seller token accounts (`token::authority = deal.buyer` / `deal.seller` constraints). A refused instruction moves nothing.
- **Mission vaults.** A mission's budget sits in a vault owned by the mission authority PDA. It leaves only through `agent_spend` (to a payee the mandate allows), `agent_open_deal` (into a new deal vault, counted against every cap), the bond of `agent_challenge` (counted as spend) and `close_mission` (back to the buyer).
- **What a stolen key can lose.** An agent key can lose at most what is left of its own mandate, only to that mandate's payees, only in approved stages, before expiry, and only until the buyer revokes it (one transaction). A verifier key can only decide challenged deals that name it, within what those deals hold. The upgrade authority can replace the program (open item 2).
- **Value at risk.** Today everything is on devnet with test USDC. In production the program custodies every dollar an owner lets an agent or a machine spend, so a program bug means money moving outside limits the owner signed. That is why we want the audit before any real funds.

## Roles and trust assumptions

| Role | Who | Can | Cannot |
|---|---|---|---|
| Upgrade authority | One key today | Upgrade the program; replace the assessor list (`set_assessors` checks the signer against the ProgramData header) | n/a: full control (open item 2) |
| Buyer | The owner | Fund deals and missions; set policy, mandates and stage approvals; release, challenge, revoke, close | Release a delivery other than the one it names; take the seller's stake outside the rules |
| Approver | The buyer's second key, in `BuyerPolicy` | Co-sign deals and stage approvals above the threshold | Spend |
| Agent | Holder of a `Mandate` | Spend and open deals within its mandate; release or challenge deals it opened | Exceed any cap, pay a non-payee, act before a stage is approved or after revoke or expiry, use another agent's mandate, weaken a deal's protections |
| Seller | Named on the deal | Accept (posting a stake), deliver, invoice within tolerance | Redirect a payout; deliver other content than a Data listing's hash |
| Verifier | Fixed at deal creation; must differ from buyer and seller | Decide a challenge within the resolve window | Act on deals that don't name it; receive tokens |
| Assessor | On the registry | Attest a listing's report hash | Attest while not registered; move funds |
| Anyone | Permissionless | `claim` after the review window, `refund` after the deadline, `timeout_refund` after the resolve window, `close_mission` after expiry | Send tokens anywhere but the deal's or mission's own parties |

## Invariants

What must always hold. The randomized attack searches compare the chain with an independent model of these after **every** step:

1. **Conservation:** tokens across all parties and vaults never change in total.
2. Every deal vault holds exactly what its deal records (order + stake + bond), and 0 once settled.
3. Buyer and seller balances equal what the deal outcomes entitle them to.
4. A stranger, the verifier and the approver never gain anything.
5. `agent_spend` is accepted **exactly** when every rule allows it: mission open and not expired, mandate live, stage approved, stage bit set, payee allowed, every cap respected.
6. No counter ever exceeds its cap, and refunds never reduce `spent`.
7. A mission vault holds budget − spent + what the mission's deals returned.
8. Nobody outside the payees gains anything from a mission.

Also enforced and tested: a refused instruction moves nothing; reputation changes only with a real payout and is kept per mint.

## Evidence

### Program tests: 97, all passing (12 Oct 2026)

The tests run the **compiled program** in LiteSVM, not a mock.

| File | Tests | Covers |
|---|---|---|
| `escrow.test.ts` | 21 | Deal lifecycle, invoice match, policy limits, windows, challenge and verdicts, payout redirection |
| `deals.test.ts` | 19 | Client library; `safeSend` never sends a landed transaction twice |
| `mission.test.ts` | 18 | Missions and mandates: caps, payees, stages, revoke, expiry, agent-opened deals |
| `listing.test.ts` | 12 | Listings, attestations, assessor registry, the `DealLink` delivery check |
| `rep.test.ts` | 10 | Reputation counts only on settlement, kept per mint |
| `exactly-once.test.ts` | 5 | A payment is sent exactly once across RPC failures (incident #210) |
| `market.test.ts` | 5 | Listings and missions through the library |
| `devnet.test.ts` | 3 | Deployed program = committed binary; every address and signature cited in the repo exists |
| `entry.test.ts` | 2 | Package entry points |
| `attack.test.ts` | 1 | Randomized attack search over deals |
| `attack-mission.test.ts` | 1 | Randomized attack search over missions |

Security tests worth reading first:
- *a caller cannot redirect a payout to their own token account* (escrow)
- *verifier must be independent of buyer and seller* · *release must name the delivered hash* (escrow)
- *the delivery check cannot be dodged by passing another account as the link* (listing)
- *assessor registry: only the upgrade authority sets it; only registered assessors can be named or attest* (listing)
- *agent_spend: nothing before approval; then every cap, payee and stage rule holds* · *an agent cannot use another agent* · *agents cannot weaken a deal* · *a pre-funded MissionDeal address cannot block an agent* (mission)
- *reputation is kept per mint: deals in a self-minted token never touch the USDC record* (rep)
- *exactlyOnce: a send that lands, then a 429, then a stale read => exactly one transaction* (exactly-once)

### Randomized attack search: extended run (12 Oct 2026)

Random instruction sequences from random signers (including a stranger who tries every instruction) with time warps, each step model-checked against the invariants above. Each run also drives a control deal that must settle, so the search cannot pass by refusing everything.

| Search | Runs | Activity | Invariant violations |
|---|---|---|---|
| Deals | 1,000 × up to 40 steps | 12,083 actions (4,742 accepted, 7,341 refused); 1,000/1,000 control deals settled; 0 of 1,667 policy-hijack attempts accepted | **0** |
| Missions | 1,000 × 40 steps | 9,811 agent spends tried (5,905 accepted, 3,906 refused); 747 deals opened by agents | **0** |

The default CI run is 60 + 40 runs. Honest limit: random sequences rarely reach some late deal states (`claim`, `refund` and `timeout_refund` succeeded once each, `resolve` 10 times, in about 550 tries each). The scripted tests in `escrow.test.ts` cover those paths; guided fuzzing is on the plan below.

### Reproducible build

The binary the tests run, the binary on devnet and a fresh build from this source are byte-for-byte identical (`cargo build-sbf` 3.1.10, platform-tools v1.52):

```bash
cargo build-sbf --manifest-path chain/anchor/programs/deal_escrow/Cargo.toml --sbf-out-dir /tmp/sbf
shasum -a 256 /tmp/sbf/deal_escrow.so chain/program/deal_escrow.so    # both d4375512…7e8c
DEAL_CHECK_DEVNET=1 npm test --prefix chain                           # includes: deployed program = committed binary
```

This is a local rebuild, not yet a container-verified build (`solana-verify`); that comes with the audited release.

### Static checks

`cargo clippy`: 1 style warning (a needless `Ok(…?)`). `cargo fmt --check`: formatting differences. We are deliberately not fixing them now: any source change would break the byte-for-byte match with the deployed program. They go into the audit-freeze commit (plan step 1).

## Design choices an auditor will ask about

1. **Any SPL token or Token-2022 mint is accepted** (`TokenInterface`, `transfer_checked`); reputation is kept per mint so a self-minted token never inflates the USDC record. There is no screening of Token-2022 extensions yet: open item 1.
2. **`init_if_needed`** creates `SellerRep`/`RepPair` on first use (in `create_deal` and in `Settle`, so deals opened before reputation existed still settle) and the singleton `AssessorRegistry`. These are PDAs keyed by their seeds; a fresh account is recognised by its zeroed key fields (`init_rep`), and Anchor does not re-initialise an existing account.
3. **`set_assessors` reads the upgrade authority from the ProgramData header by hand** (account tag 3, option flag at byte 12, authority at bytes 13..45). The ProgramData address and owner are constrained.
4. **Self-CPI.** `agent_open_deal`, `agent_release` and `agent_challenge` re-enter `create_deal`, `release` and `challenge` with the mission authority PDA as signer, so every deal rule applies to agents too. Every program-owned account the inner instruction writes (deal, policy, reputation, link, listing) is an `UncheckedAccount` in the outer one, and the vaults are token accounts that Anchor never serialises back, so the outer instruction cannot write a stale copy over the inner one's changes. The outer instruction updates only mission and mandate counters, which the inner one never touches.
5. **Unchecked accounts** (`read_deal`, `read_link`): the owner must be this program and the Anchor discriminator must match. The `DealLink` address is constrained by its seeds, so it cannot be swapped (see the listing test above).
6. **Arithmetic:** counters use checked math; basis-point math is done in `u128`; `saturating_add` is used only to compute window ends from timestamps.
7. **Bounds:** at most 8 stages, 8 payees, 8 allowed sellers, 16 assessors; windows of at most 30 days; a resolve window of at least 60 s; tolerance ≤ 20 %; bond ≤ 50 %.

## Open items (known, to fix before real funds)

1. **Token-2022 extensions.** A mint with a transfer fee, a permanent delegate, a transfer hook or frozen-by-default accounts could leave a vault short, drained or stuck for a party that accepts such a mint. Fix: allow only listed mints (USDC first) or reject those extensions when a deal or mission is created.
2. **Single-key upgrade authority**, which also controls the assessor list. Fix: a multisig (e.g. Squads) with a timelock before mainnet.
3. **The verifier is a trusted party per deal.** It is fixed at creation and must differ from buyer and seller; a missing verdict refunds the buyer. A dispute is only as fair as the verifier the buyer and seller agreed on.
4. **Layout and lint:** one 1,979-line file, the clippy warning and rustfmt. These go into the audit-freeze commit without logic changes.
5. **CI tests the committed binary.** It does not yet rebuild from source or run clippy/fmt. Fix: a CI job that rebuilds and compares the hash.
6. **Search depth:** late deal states are rare in the random search (see above). Fix: guided fuzzing, e.g. Trident.
7. **Mint freeze authority:** USDC's issuer can freeze any account, including a vault. This is inherent to USDC.

## Incidents

- **#210, devnet double payment (client side, fixed).** An `agent_spend` landed, its confirmation failed with HTTP 429, a stale read said "not landed", and the client resent a second valid payment. The program behaved correctly: both payments were within the mandate's caps. Fix: `exactlyOnce` waits out the blockhash window before trusting a "not landed" read. Tests: `exactly-once.test.ts`, *missions.spend: a 429 after the payment landed is settled by the chain, never paid twice* (`market.test.ts`).

## Plan to mainnet (security track)

1. Audit-freeze commit: split the file into modules, apply fmt and clippy, change no logic; the tests and the attack search must pass unchanged.
2. Close open item 1 (allowed mints or extension screening).
3. External audit, fixes, and a review of the fixes.
4. Container-verified build (`solana-verify`), with the hash published.
5. Move the upgrade authority to a multisig with a timelock.
6. Capped launch with real USDC: conservative per-mandate and per-period caps.
7. Monitoring of `DealEvent`/`SpendEvent`, and a bug bounty.

This matches the README roadmap: external audit, multisig upgrade authority and a capped launch with real USDC in Q1 2027.
