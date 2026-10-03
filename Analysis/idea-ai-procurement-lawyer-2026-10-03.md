# Idea: an AI procurement lawyer for the agent economy

_Proposed 3 Oct 2026 by Dhruv. Status: candidate direction, not yet decided. Builds on the novelty
conclusion in `session-log-2026-10-01-to-03.md` §2.12._

## One line

You say what you need. The AI finds the right agent or service, agrees the terms, and puts the deal into
an on-chain contract that pays only when the service is delivered.

Pitch: **"The AI writes the terms; Solana enforces them."**

## Why this instead of agent budgets alone

Agent spending caps are common (about 60 ETHOnline teams; Cordon reached the finals with our exact
mechanism; Solana already has the fixed-delegation program and Squads limits). The pieces of this idea
exist separately, but not as one flow, and not on Solana:

| Step | Who already does it | Gap |
|---|---|---|
| Find services | OnchainRouter (finalist), Bazantic, x402 Bazaar | Discovery only, no deal terms |
| Escrow a deal | Pact (two-party escrow on ENS), OpenBook (refund on stale data), Recibo | One fixed deal shape each |
| Turn a need into enforceable terms | Nobody found | **The new part** |
| All of it on Solana | Nobody found | **The new part** |

## The key design rule: the AI never writes contract code

AI-generated smart contracts can contain bugs that lose money, and no judge or company will trust them.
Instead:

- One audited Solana program holds a small set of **deal templates**.
- The AI only **chooses a template and fills in the terms**: price, deadline, quality check, refund rule,
  spending cap.
- The program validates the terms and enforces them: holds the money, releases on delivery, refunds on
  failure or timeout.

### Templates

| Template | How money moves | Example |
|---|---|---|
| **Pay on delivery** (build first) | Buyer funds escrow; seller paid when delivery is confirmed; refund if the deadline passes | "Translate this document by 6 pm for 2 USDC" |
| Pay per call | Many small payments against a cap (x402) | Data API at 0.01 USDC per query |
| Milestones | Escrow released in parts | A multi-step research job |
| Subscription | Periodic pull up to a limit | A monitoring agent at 5 USDC a week |

## How it works

1. **Ask.** "I need a market report on battery suppliers by tomorrow, under 20 USDC."
2. **Find.** The AI searches service listings and shows 2–3 options with price and track record.
3. **Draft terms.** It picks a template and fills it in, in plain language the user approves.
4. **Lock.** One Solana transaction creates the deal account and moves the money into escrow.
5. **Deliver.** The service delivers; the delivery is recorded (hash) on the deal account.
6. **Settle.** The program releases payment, or refunds automatically on a missed deadline or a failed
   check. A receipt stays on-chain.

## Where our existing work fits

- The budget and refusal logic (`core/` in the old project: caps, attenuation, `OVER_LIMIT`, `REVOKED`)
  becomes the buyer's spending limit inside each deal.
- The x402 server and MCP tools (`surface/`) become the "pay per call" template and the agent interface.

## Why it fits the WHU judging

- **Useful idea:** procurement and legal for the AI economy; a business story a business-school jury
  recognises.
- **Clear role for Solana:** the program holds the money and enforces the deal; remove it and nothing is
  guaranteed.
- **Potential to grow:** a marketplace with a fee per deal; more templates over time.

## Scope for the deadline (about one day)

Build:
1. One template, **pay on delivery with refund on missed deadline**, as an Anchor program on devnet.
2. A simple "find a service" list (a few hard-coded or registry-listed services).
3. The AI step that turns a request into filled-in terms the user approves.
4. A live demo: a deal that pays, and a deal that refunds.

Present as roadmap: more templates, reputation, disputes, a public service registry.

## Risks

- **Time.** This is larger than the earlier plan; keep to one template.
- **"Delivered" is hard to prove** in general. For the demo, confirm delivery by the buyer or by a simple
  check (file hash present, API returned 200).
- **Prior art may exist** that a quick search missed; run a prior-art check before pitching novelty.
