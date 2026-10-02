# Use case, value proposition and mentor feedback

_Written 2026-10-02. Follows `Analysis/research-angles-2026-10-01.md`. Covers the WHU challenge
read, the Solana infrastructure we can build on, the mentor meeting, and the business ideas that came
out of it. Estimates are ours, not facts._

## 1. The challenge: "Build an MVP with Solana at WHU"

Source: [Superteam Earn listing](https://superteam.fun/earn/listing/build-at-whu), read 2026-10-01.

- Organiser: Superteam Germany. Private: WHU Hackathon 2026 participants in Germany only.
- Prizes: 1,500 / 1,000 / 500 USDG. Winners announced **8 Oct 2026**.
- Deadline: about **5 Oct 2026, 00:00 CEST** (3d 4h left on 1 Oct ~20:00) — confirm on the listing.
- Field: **6 submissions** on 1 Oct, 3 prize places.
- Submit: pitch-deck link, public GitHub repo, follow @SuperteamDE on X.
- Judging: **useful idea**, **working prototype**, **clear role for Solana**, **potential to grow**.
- Tone: "all backgrounds welcome", "start small: one useful feature that works is enough".
- Our area is listed as inspiration: *"Tools and services that let AI agents make payments or interact
  with applications."*

### Chance of winning (our estimate)

| Scenario | Top 3 | 1st |
|---|---|---|
| Focused: one feature works live + clear business deck | ~55–70% | ~25–35% |
| Over-scoped: everything attempted, half finished | ~15–25% | <10% |
| Strong code, weak deck / no clear user | ~30–40% | ~10% |

Base rate ~50% with 6 entries for 3 prizes; expect 10–20 by the deadline. Scope is the biggest risk.

## 2. Solana infrastructure we can build on

| Layer | What exists | Notes |
|---|---|---|
| Agent pays for APIs | x402: `@x402/svm`, `@x402/core`, `@x402/express`, `@x402/fetch` (v2.28.0); alt `x402-solana` (v3.0.1) | Devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; any SPL / Token-2022 token, usually USDC; facilitators PayAI, Coinbase CDP. `exact` works on Solana; `upto` conflicting docs ([FAQ](https://docs.x402.org/faq.md) says EVM-only, [Coinbase news](https://solanacompass.com/news/coinbase-upgrades-x402-facilitator-on-solana-upto-scheme-live-verify-latency-cut-66) says live 17 Sep) |
| Budget: simplest | SPL Token `approve` / `revoke` (`@solana-program/token`) | One delegate per token account → one token account per agent; no vendor or period rules ([docs](https://solana.com/docs/tokens/basics/approve-delegate)) |
| Budget: agent-specific | Fixed-delegation program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` | Amount + expiry, agent signs `TransferFixed`, `AmountExceedsLimit`, revoke anytime; devnet only, no JS client, maintainer unclear ([Chainstack](https://docs.chainstack.com/docs/solana-agent-allowances-x402.md)) |
| Budget: closest to "company card" | Squads spending limits (`@sqds/multisig` v2.1.4) | Token, amount, reset period, **destinations allowlist**, expiry ([docs](https://docs.squads.so/main/development/reference/spending-limits), [API](https://developers.squads.so/api-reference/spending-limits/create-a-spending-limit.md)); devnet support to verify |
| Budget: fully custom | Token-2022 transfer hook | Checks every transfer; Token-2022 mints only (wrap USDC); roadmap ([guide](https://solana.com/developers/guides/token-extensions/transfer-hook)) |
| Agent wallets | Solana Agent Kit v2 with Turnkey / Privy embedded wallets | Scoped keys with caps, but enforced by those companies' servers, not the chain |

**Build choice:** Squads spending limits + `@x402/svm` on devnet with USDC; fall back to SPL
`approve`/`revoke` if Squads setup fights us. Test both on day 1.

## 3. Mentor meeting

### Questions we prepared
1. Is an AI-agent payments idea too technical for this jury?
2. Is the demo judged live, by video, or deck only?
3. Is devnet okay?
4. Exact deadline and timezone?
5. Can we submit an existing codebase we are porting?
6. Would a startup pay for "company cards for AI agents"? Anyone running agents that spend money?
7. Is anyone in the Solana ecosystem building this already?
8. AI agents or machine fleets (EV, IoT) — which customer is more convincing?
9. Squads spending limits or SPL approve/revoke? Does Squads work on devnet?
10. PayAI or Coinbase as facilitator on devnet?
11. Is `upto` really live on Solana?
12. A contact at Squads / PayAI / Solana Foundation?
13. Which one extra feature impresses most: approved vendors, Blink approval, spending report,
    parent-to-helper budgets, auto-freeze?
14. Developers first or companies first?
15. Business model or growth potential?
16. Feedback on the one-liner.

Framed question on shape: *"Should we pitch this as a Solana building block — an on-chain
spending-limit program plus SDK that other agent apps integrate — or as a complete product, a
'company card for AI agents' dashboard built on top of it?"*

### What the mentor said
1. **Apply it to a specific use case** — the underlying features (budgets, spending limits, x402)
   already exist on Solana, so the infrastructure alone is not the product.
2. **The value proposition must be clean.**
3. **It must be a *unique* value proposition — look more towards the business idea.**

## 4. Clean value proposition

A clean value prop answers "why should a customer care?" in about five seconds, with no tech words.

- Formula: **For** [specific user] **who** [painful problem], **[product] lets them** [one outcome],
  **unlike** [what they do today].
- Test: no jargon (blockchain, x402, on-chain), one specific user, one clear benefit.
- Solana goes in the second sentence as the reason to believe: *"Limits are enforced by Solana
  itself, so even a hacked agent can't break them."*

Not clean: "capped, revocable spending delegation for AI agents using x402, enforced on-chain".
Clean: "Your AI assistant can buy things on its own, but it can never spend more than you allow."

## 5. Use cases considered

| # | Use case | Clean value prop |
|---|---|---|
| 1 | Consulting / VC research analyst | "Every euro your AI analyst spends on data is automatically billed to the right client." |
| 2 | EV fleet charging | "Give every van its own charging card that can't be misused, and see exactly what each vehicle costs." |
| 3 | AI cost control for startups | "Your AI agents can never spend more than you allow, and you know where every cent went." |
| 4 | University research budgets | "Let your research AI buy papers and data on its own, without ever overspending the grant." |
| 5 | E-commerce restocking agent | AI reorders from approved suppliers within a monthly budget |
| 6 | Marketing agency ad spend | Per-client campaign budgets with automatic client reports |
| 7 | Travel and expense booking | Bookings inside company travel policy; over-policy goes to the manager |
| 8 | Teen allowance with an AI shopper | Weekly budget, approved shops, instant cancel |

Comparison of the top three:

| | Jury relates | Clear Solana role | Demo effort | Growth story |
|---|---|---|---|---|
| 1. Research analyst (client billing) | high | high | medium | every consulting / VC / law firm |
| 2. EV fleet | medium | medium | medium-high (mock chargers) | medium |
| 3. AI cost control | medium | medium | low | medium |

## 6. Unique value proposition

Unique = why choose us over company cards (Ramp, Revolut Business), Coinbase, Squads or a normal app.

Where cards and existing tools fail:
1. **Tiny payments** — cards cost roughly €0.30 + 2–3% per payment; an AI paying €0.002 per API call
   thousands of times a day is impossible by card, and costs a fraction of a cent on Solana.
2. **Machines paying without a human** — cards need logins, 3-D Secure, SMS codes.
3. **Proof of every purchase** — a card statement cannot prove which agent bought what, for which
   client, for which task; Solana receipts can.
4. **Instant global settlement** — no bank delays or FX fees.

### Business ideas with a UVP

1. **Pay-per-use data for AI analysts (consulting / VC)** — *recommended*
   - UVP: *"Your AI pays for data by the question, not by the subscription — cents instead of
     €10,000/year licences, and every cent billed to the right client."*
   - Unique because data vendors sell annual subscriptions today; micropayments by card don't work.
   - Revenue: % per sale from data vendors (we bring AI buyers) + per-seat fee for firms.
   - Two-sided: data sellers reach AI buyers; firms control and attribute spend.
2. **"Stripe for AI agents" for API sellers** — turn any API into pay-per-call for agents in five
   minutes. Crowded (PayAI, x402 itself).
3. **AI procurement for small businesses** — AI reorders supplies within budget, pays suppliers
   instantly. Weak point: suppliers must accept stablecoins.

### Follow-up question for the mentor
*"Our UVP: AI analysts pay for data per question in cents instead of €10k subscriptions — only
possible with Solana micropayments — and every cent is auto-billed to the right client. Is that
unique enough?"*

## 7. Recommended direction

- **Use case:** AI research analyst for consulting / VC teams, paying for data per question.
- **One-liner:** "Data by the question, not by the subscription."
- **Demo (2 minutes):** "Research Tesla's battery suppliers for Project X" → agent buys three data
  reports (works) → unapproved vendor refused → budget cap refused → partner approves one large
  purchase from the phone → per-client billing report ready to invoice.
- **Reuse:** `core/` (per-project budgets, refusal codes), `surface/` (x402 server, MCP tools).
- **Roadmap slide, not built:** vendor bonds, verified metering, settlement binding, machine fleets.
