# Research: new angles for the agent-spending project on Solana

_Written 2026-10-01 in a Claude Code research session. Builds on `Analysis/strategy.md` (2026-09-29).
Sources are linked inline; anything marked **(our inference)** is analysis, not a cited fact._

## 0. Summary

- The existing project (`ehl_switerland`, Hedera + ENS) gives a child agent a **capped, revocable
  spending authority** from a parent and refuses over-budget/revoked payments **before any money
  moves**, with reason codes (`OVER_LIMIT`, `REVOKED`, `PARENT_REVOKED`) and an MCP tool surface.
- Its own docs already concede the mechanism is not novel (ADR-0003: "no unoccupied mechanism left in
  agent delegation and agent payments in 2026"). Research since confirms it: capped/revocable agent
  budgets already exist on Solana and on Hedera.
- What is still open, with evidence of demand: **binding payment to settlement on-chain** (the
  "free shopping" class across 15 x402 facilitators), **verifiable metered billing** (`upto` lets the
  seller charge anything up to the cap), **fleet budgets inside one payment channel**, and
  **program-enforced policy against prompt-injection drains**.
- Recommended direction: **a safety layer for agent payments on Solana** — guard the buyer
  (velocity limits, timelock on large spends, parent veto), bond the seller (slashable deposit for
  non-delivery or overcharging), keep the existing `core/` for budgets, revocation and refusal codes.

## 1. Which hackathon the original project was for

- There is **no ETHGlobal hackathon in Switzerland**; the only Swiss item on
  [ethglobal.com/events](https://ethglobal.com/events) is a 2025 Zug meetup. The folder name
  `ehl_switerland` is the source of the confusion (`COMPETITION.md` lists it as unresolved, Q-0001).
- Evidence points to **ETHOnline 2026** (online, 4–16 Sep): the repo uses Blocky402, which is a hard
  requirement of Hedera's ETHOnline track; the sponsors (Hedera, ENS, Bazantic) match; ADR-0005 says
  "this event is online".
- Hedera's ETHOnline 2026 tracks ([genfinity](https://genfinity.io/2026/08/27/hedera-15k-bounties-ethonline-2026-agentic-ai-payment-tokenization/)):
  Agentic Payments (x402) 3 × $2k — live x402 service via Blocky402, bonus for metering, multi-agent
  settlement, audit trails, ERC-8004/HCS-14 identity; Asset Tokenization 3 × $2k; Hedera Harness OSS
  2 × $1k; Continuity $1k.
- **Correction (2026-10-02):** an earlier version of this section said our project was not on the
  showcase and that no winners were published. Both were wrong. Our project was submitted as
  [Capability Descent](https://ethglobal.com/showcase/capability-descent-7mmjb) and did not place;
  winners are published as prize badges and in the finale stream. See
  `ethonline-2026-winners-and-competitors-2026-10-02.md` and `ethonline-2026-postmortem-2026-10-02.md`.

### Competing ETHOnline 2026 submissions (sampled before the winners list was found)

| Project | What it does | Overlap |
|---|---|---|
| [Recibo](https://ethglobal.com/showcase/recibo-5xkrv) | Escrow + proof-of-delivery for x402, state log on Hedera HCS | Escrow/refund idea — crowded |
| [FieldProof402](https://ethglobal.com/showcase/fieldproof402-btphu) | Agents pay humans via x402 to verify real-world facts | Different, very polished |
| [Freeride](https://ethglobal.com/showcase/freeride-rd324) | Free-tier AI routing; agent pays via x402 when free runs out | Autonomous agent payment |
| [Floatt](https://ethglobal.com/showcase/floatt-7yjk2) | ENS treasury; agent with session-key-restricted permissions sweeps idle stablecoins to yield; uses Bazantic | **Closest to "capped agent authority"** |
| [Agentry](https://ethglobal.com/showcase/agentry-qp8ab) | Ledger-secured purchase agent paying via x402 on Hedera | Agent buying |
| [Vector52](https://ethglobal.com/showcase/vector52-kw1up) | Pay-per-request on-chain forensics via x402 + MCP | Paid agent API |

### Real winners nearby: Hedera x402 bounty (announced 2026-08-31)

[Hedera blog](https://hedera.com/blog/x402-bounty-on-hedera-winners-announced.md), $1,000 each:
**Pinout** (per-second/per-token CPU/GPU rental), **Tally** (x402 `upto` on Hedera — *enforceable
spending caps for agents*), **Xorv** (resale of unused AI subscription quota), **Qisma** (atomic
supply-chain settlement), **Mystic** (pay-per-minute VPN).

Takeaway: "spending caps for agents" alone has already won (Tally). Winners applied x402 to something
concrete. Nobody verifies that metered charges are honest.

## 2. What already exists — do not rebuild

| Idea | Already done by |
|---|---|
| Capped, revocable agent budgets on Solana | Solana fixed-delegation program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` — `create_fixed_delegation(amount, expiry_ts)`, agent-signed `transfer_fixed`, `AmountExceedsLimit`, revoke anytime ([Chainstack](https://docs.chainstack.com/docs/solana-agent-allowances-x402.md)) |
| `upto` (authorise a ceiling, settle actual) on Solana | Coinbase facilitator, live 2026-09-17, via a payment-channels program ([Solana Compass](https://solanacompass.com/news/coinbase-upgrades-x402-facilitator-on-solana-upto-scheme-live-verify-latency-cut-66)) |
| Batch settlement on Solana | PayAI, public preview (same source) |
| Refunds via escrow + arbiter | [x402r](https://www.producthunt.com/products/x402r-refund-protocol) |
| Agent chargebacks with AI/TEE arbitration | [Clawback](https://ethglobal.com/showcase/clawback-vpmw2) (ETHGlobal NY 2026, Arc; won ENS prize) |
| ZK-proof-gated settlement | [ethresear.ch design](https://ethresear.ch/t/atomic-zk-proof-gated-settlement-for-x402-agent-payments-a-measured-reference-design/25660) (EVM) |
| Escrow + delivery log on Hedera | Recibo (above) |
| Server-side wallet policy against prompt injection | Virtuals Protocol ([Crypto Briefing](https://cryptobriefing.com/virtuals-protocol-agent-wallet-prompt-injection/)) |
| ERC-8004 agent identity/reputation | Live on Ethereum + L2s since Jan 2026 ([Cobo](https://www.cobo.com/post/erc-8004-on-chain-identity-standard-for-ai-agents-the-future-of-agentic-wallets)) |

## 3. Open problems with evidence of demand

### 3.1 "Free shopping": verification not bound to settlement
- A 2026 study found **31 vulnerabilities across 15 x402 facilitators (incl. Coinbase, Thirdweb,
  PayAI), covering 99% of x402 transactions**; every facilitator failed at least one rule
  ([CryptoSlate](https://cryptoslate.com/31-newly-discovered-vulnerabilities-expose-99-of-x402-crypto-payments-to-asset-theft-and-free-shopping/),
  [CryptoSlate 2](https://cryptoslate.com/coinbase-and-14-other-x402-facilitators-failed-security-tests-built-for-the-coming-ai-agent-economy/)).
- Classes: free shopping (service released before a unique payment settles), asset theft, service
  denial, gas abuse. The researchers' fix: **"binding verification to settlement"**, release service
  only after settlement, cap sponsored fees.
- Related papers: [Formal Analysis of Agent Payment Protocols](https://arxiv.org/pdf/2609.00060),
  [Five Attacks on x402](https://www.themoonlight.io/en/review/five-attacks-on-x402-agentic-payment-protocol)
  (authorization, binding, replay, web-layer).

**Program-level fix (our inference):** the payment instruction initialises a receipt PDA seeded by
`hash(request, vendor, amount, nonce)`. Re-use fails because the PDA already exists; the server
releases only once the PDA is visible. One audited program instead of 15 hand-written facilitators.

### 3.2 `upto` trusts the seller up to the ceiling
- Under `upto` the buyer authorises a maximum and the **seller decides the final amount**; nothing
  checks it against real usage.
- Apify ("x402 isn't good yet", [talk notes](https://www.sean-weldon.com/blog/2026-09-05-x402-isnt-good-yet-jan-curn-apify),
  [coverage](https://www.startuphub.ai/news/x402-isn-t-good-yet-apify-says)): exact scheme is fixed-fee
  only; they charge upfront and refund the rest (two transactions plus client trust); also flags
  double-spend exposure before settlement, the **MCP 401 vs x402 402 status-code conflict**, and the
  lack of local wallet test tools.

**Program-level fix (our inference, not found elsewhere):** dual-signed metering — the buyer SDK
counts what it received and signs a usage receipt; the program pays
`min(seller claim, buyer-signed count)` immediately; the difference sits in escrow against a
**seller bond** and goes to whichever side can prove its count (e.g. seller reveals response hashes
the buyer committed to).

### 3.3 Fleet budgets inside one payment channel
Payment channels today are one buyer key to one seller. A company running 50 agents needs 50
deposits and cannot revoke one agent's vouchers without closing everything. Not found elsewhere
(our inference; verify).

**Fix:** parent deposits once; children sign vouchers against sub-caps; an on-chain revocation
invalidates any voucher a child signs after that slot; siblings unaffected. This is the existing
`core/` algebra moved on-chain.

### 3.4 Prompt-injection drains: protection still lives on a server
- 2026: **>$150k drained from an AI agent via prompt injection**; industry fix (Virtuals) is
  server-side policy ([Crypto Briefing](https://cryptobriefing.com/virtuals-protocol-agent-wallet-prompt-injection/)).
- The Solana fixed-delegation program checks only amount and expiry.

**Fix:** program-enforced policy — vendor allowlist, per-call max, velocity limit, cooldown after
anomalies — so a fully compromised agent still cannot pay outside the rules.

### 3.5 Market size caveat
x402 volume is still about **$1M/month** ([startuphub](https://www.startuphub.ai/ai-news/web3--blockchain/2026/x402-isn-t-good-yet-apify-says)).
This is infrastructure for a market that is forming, not one that is large today.

## 4. Angles from the Superteam ideas bank

Source: [superteam.fun/build/ideas](https://superteam.fun/build/ideas) (521 ideas, read 2026-10-01).
Some entries are years old: they show what Superteam wants built, not proof of current demand.

| # | Ideas-bank entry (quoted) | Angle for this project |
|---|---|---|
| 1 | **Transaction Guards** — "wallets are vulnerable to instant draining in case their private key gets compromised" | Guard agent keys: velocity limits, timelock on large spends with parent cancel window, auto-freeze; new refusal codes `VELOCITY_LIMIT`, `IN_DELAY_WINDOW`, `FROZEN` |
| 2 | **Reputation-based Slashing** — "dealing with unreliable sellers can be a poor experience for buyers" | Vendor bonds slashed for non-delivery or `upto` overcharging (§3.2) |
| 3 | **Enabling Financial Transactions on IoT devices**, **Pay-Per-Watt EV Charging**, **Subscriptions built on Streamflow** | Same parent/child tree for machine fleets: operator → vehicles/devices; revoke a stolen device, others keep working |
| 4 | **Rug Detection API**, **Security Analysis Tool**, **Smart Contract and Wallet Address Analyzers** | Pre-payment vendor risk check; refuse with `VENDOR_RISK` |
| 5 | **Futarchy Controlled Agent** — "trust between human token holders and AI-run agents is broken, since AI cannot be held legally accountable" | Parent is a DAO or decision market that sets and revokes the agent's budget |
| 6 | **Crypto Payroll Solution**, **Programmable Money** | Payroll for AI workers: resetting monthly allowances, per-category expense limits, spend report |
| 7 | **AI Web Crawlers**, **Decentralized Scraping Hub**, **Data Marketplace on Solana** | Pay-per-crawl with per-site crawler budgets (note: Cloudflare already offers pay-per-crawl; the Solana fleet-budget version is the new part) |
| 8 | Evals — "we need better ways to evaluate and compare AI models, particularly as agents become more common" | Value-per-dollar leaderboard built from spend logs |
| 9 | **Generative Crypto Agents** — agents interacting and trading with each other | Adversarial agent-economy simulator to red-team spending policies on devnet |

## 5. Earlier idea list (smart-contract brainstorm, for reference)

Wrapped "scoped dollars" (Token-2022 transfer hook enforcing vendor allowlist/per-call cap/expiry;
USDC itself is classic SPL, so it must be wrapped), compressed-NFT receipts, escrow + disputes,
vendor bonds, on-chain price lists, Blink approvals above a threshold, dead man's switch, Squads
multisig for limit raises, revenue flowing up the agent tree, agent job market, agent credit
scores/credit lines, per-second streaming payments.

## 6. Recommendation

**"A safety layer for agent payments on Solana"** — combine §3.1, §3.2, §3.4 and ideas-bank #1 + #2:

1. **Guard the buyer:** program-enforced policy (vendor allowlist, per-call max, velocity limit),
   timelock on large spends with parent veto, auto-freeze.
2. **Bind payment to settlement:** receipt PDA per request; no release before it exists; replay
   impossible by construction.
3. **Bond the seller:** slashable deposit; dual-signed metering for `upto`.
4. **Reuse `core/`:** budgets, attenuation, subtree revocation, refusal reason codes, MCP tools.

Second choice for a more tangible demo: **machine fleets** (ideas-bank #3).

## 7. Before committing

- Run a prior-art check (e.g. the `prior-art-adversary` agent) on §3.2 dual-signed metering and §3.3
  fleet channels — both are our inference and were only briefly searched.
- Re-check the ETHOnline 2026 showcase for winners once judging is published.
- Correction to `Analysis/strategy.md`: it says no real payment ever settled; `ehl_switerland`
  `STATE.md` records three Hedera testnet settlements on 2026-09-11 (H-1, H-2).
