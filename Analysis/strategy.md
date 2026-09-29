# Strategy: competition read + reuse of the agentic-payments project

_Written 2026-09-29. Sources: `Competition Analysis/`, `Ideas/Ideas_Bank_Analysis.pdf`, and the
`ehl_switerland` repo (README, STATE, RESULTS, ADR-0005, code layout)._

## 1. The competition — "Build an MVP with Solana at WHU"

- **Organiser:** Superteam Germany. Private listing: WHU Hackathon 2026 participants only.
- **Prizes:** 1,500 / 1,000 / 500 USDG (3,000 total). Winners announced **8 Oct 2026**.
- **Deadline:** roughly **4–5 Oct 2026** — derived from "~5d 6h left" on 29 Sep. **Confirm the exact
  time and timezone on the listing.**
- **Field:** 3 submissions so far.
- **Submit:** public GitHub repo, pitch-deck link, follow @SuperteamDE on X.
- **Brief:** a working MVP that uses at least one Solana feature (payments, digital ownership, or an
  existing Solana app).

### Judging criteria and what they imply

| Criterion | What it rewards |
|---|---|
| A useful idea | A clear problem and a specific user |
| A working prototype | One core feature that works live — not breadth |
| A clear role for Solana | Solana has to be necessary, not added on top |
| Potential to grow | Who adopts it first and why — a business story |

WHU is a business school: expect judges to weigh user, market and go-to-market over engineering.
The pitch deck matters as much as the code.

The ideas bank's #1 pick is **AI agents making payments on Solana**, and the organiser lists it as
an inspiration area — this is where the existing project fits.

## 2. The agentic-crypto project (`~/Dhruv/ehl_switerland`)

**What it is:** a parent agent gives a child agent a capped, revocable spending allowance. The child
spends it on x402-gated (HTTP 402) paid APIs. Over the cap, or once revoked, the payment is refused
**before any money moves**, with a reason code the agent can act on: `OVER_LIMIT`, `REVOKED`,
`PARENT_REVOKED`.

**Stack:** ~3,900 lines of TypeScript.

| Part | Contents | Useful for Solana? |
|---|---|---|
| `core/` | Grant/revoke rules — a child gets at most its parent's authority; revoking a parent cuts off its whole subtree. No network or chain code. Property-tested at depths 1–5. | **Yes, as is** — chain-independent |
| `surface/` | x402-gated server, browser demo, MCP server (6 tools; refusals are normal results, not errors) | **Mostly** — payment backend sits behind an interface |
| `chain/` | Hedera settlement via Blocky402, verification against the Hedera mirror node, ENS lookups on Sepolia | **No** — Hedera/Ethereum-specific, needs rewriting |

**Completeness:** every claim is tracked with its evidence in `RESULTS.md`.
- **Proven:** grant rules (C-1..C-4), refusal before payment (H-3), mirror-node checks (H-4, H-5),
  ENS lookups (E-1, E-2, E-4, E-5), MCP tools (M-1..M-3).
- **Missing:** no real payment ever settled (H-1, H-2 blocked on a Hedera testnet key).
  `COMPETITION.md` and `VISION.md` are still unfilled `TODO(Dhruv)` placeholders.

## 3. Porting it to Solana

The idea matches the competition's AI-and-payments theme and more than half the code carries over.
The weak spot is **"a clear role for Solana"**: today the cap is enforced by *our server* and the
chain only settles, so a judge can fairly ask why a blockchain is needed.

**Fix: have Solana enforce the cap itself.**
- **SPL Token `approve` / `revoke`** (built-in delegation) already means "this key may spend up to N
  USDC, revocable". One token account per child agent, since a token account has a single delegate.
- Or **Squads spending limits** for the same across several agents.

Either way the refusal happens on chain even if our server is bypassed — a direct answer to
"why Solana".

### Suggested scope

1. Keep `core/` and most of `surface/` — the MCP tools and the refusal demo show well.
2. Replace `chain/` with:
   - x402 payments in USDC on Solana devnet;
   - on-chain enforcement through approve/revoke delegation;
   - payment verification via RPC `getTransaction`, replacing the mirror-node check.
3. Drop ENS; optionally use `.sol` names (SNS) for agent identity.
4. Pitch it as a business product, e.g. **"company cards for AI agents"**: a team gives each agent a
   USDC budget, sees its spend, and can cut it off instantly. First users: startups running paid AI
   agents — this answers "potential to grow".
5. Get a devnet wallet and faucet airdrop so real transactions happen. The Hedera version never
   settled a payment for lack of a key; a live payment is what makes the prototype convincing.

### Risks to check before starting

- **Is existing code allowed?** Pre-event code may be ruled out for a participant bounty. Check
  first; if not allowed, reuse the design and write the code fresh here.
- **Novelty:** `ehl_switerland`'s own records list prior art (VERA, UCAN, `bazantic grant`). Pitch a
  useful, working product, not a new mechanism.
- **Time:** ~5 days for build, deck and demo.
