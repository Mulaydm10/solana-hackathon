# ETHOnline 2026: winners, finalists and projects like ours

_Written 2026-10-02. Sources: the ETHGlobal showcase (all ETHOnline 2026 projects scraped, 812 parsed),
each winner's project page ("Winner of …"), and the auto-captions of the
[ETHOnline 2026 Finale](https://www.youtube.com/watch?v=ZGIvHtWMXZs) (16 Sep 2026). Prize amounts come
from auto-captions and may be misheard. This corrects `research-angles-2026-10-01.md` §1, which said
no winners were published: they are, as prize badges on the showcase and in the finale stream._

## 0. "ETHGlobal Switzerland"

- There was **no ETHGlobal hackathon in Switzerland** in 2026 (in person: Cannes, New York, Lisbon,
  Tokyo, Mumbai). The only Swiss ETHGlobal item is a 2025 Zug meetup.
- The "Switzerland" project is ours: **Capability Descent** —
  [showcase](https://ethglobal.com/showcase/capability-descent-7mmjb), repo
  `github.com/Mulaydm10/ehl-switzerland-hackathon`. It was submitted to **ETHOnline 2026** (online,
  4–16 Sep, 800+ submissions). **It won no prize and was not a finalist.**

## 1. The 8 finalists (first time ETHOnline had finalists with live demos)

Each finalist gets ETHGlobal Plus for a year, 1,000 USDC per team member, a $500 flight credit, and
an ETHConf 2027 pass.

| Finalist | What it does | Sponsor prizes also won |
|---|---|---|
| [OnchainRouter](https://ethglobal.com/showcase/onchainrouter-8r4jm) | "OpenRouter for onchain tools": agents find, call and pay per use with x402 (Hedera / Arc); no answer, no charge | — |
| [OpenBook](https://ethglobal.com/showcase/openbook-8ngw6) | Data marketplace for AI agents: "fresh data or your money back"; refunds for stale data, seller reputation on ENS | Arc Best Agentic Economy App ($3.5k); The Graph 3rd |
| [TARE](https://ethglobal.com/showcase/tare-ozced) | Measures what a Uniswap v4 hook really takes from your swap | Uniswap Best Stack Contribution |
| [ETH Arcade](https://ethglobal.com/showcase/eth-arcade-96wyn) | Handheld arcade where the ETH price is the game, plus an SDK | — |
| [Novi Corpus](https://ethglobal.com/showcase/novi-corpus-qtfxd) | Wyoming LLC for an AI agent: human guardian (World ID), treasury with spending limits the agent can't exceed, ERC-8004/ENS identity | World AgentKit Continuity |
| [Petri](https://ethglobal.com/showcase/petri-mjy1y) | Darwinian evolution for agent harnesses: mutate, test, keep verified winners | — |
| [LeekDIYHardwareWallet](https://ethglobal.com/showcase/leekdiyhardwarewallet-5qssg) | $15 open-source ESP32 hardware wallet, refuse-by-default signing | — |
| [Cordon](https://ethglobal.com/showcase/cordon-vw3kh) | One shared budget for a team of AI agents and their sub-agents; balances cost against performance | — |

## 2. All sponsor-prize winners (60 badges, 58 projects)

| Sponsor · prize | Winners |
|---|---|
| **Hedera** · AI & Agentic Payments ($6k, split 3 ways) | [Turnstile](https://ethglobal.com/showcase/turnstile-ovks1), [AutoVoyage](https://ethglobal.com/showcase/autovoyage-r11zz), [Carpool](https://ethglobal.com/showcase/carpool-f4bez) |
| Hedera · Improve the Hedera Harness | Hanvil, Scenario Engine |
| Hedera · Tokenization of Anything | Rialto, NameGate, Facture |
| Hedera · Continuity | Aivy Quorum, YourTurn 2.0 |
| **Arc** · Best Agentic Economy App (Circle stack) | OpenBook |
| Arc · Best DeFi / Onchain Finance App | T-REX Capital Market |
| Arc · Best DeFi or Agentic App (continuity) | ACR |
| **Bazantic** · Agentify a new API | 1 Margit, 2 LATCH, 3 Legwork |
| Bazantic · Best Recipe with sponsor APIs | 1 NotYet, 2 Mandate-app, 3 Assay |
| Bazantic · Help an Agent Use Your Project (continuity) | payOrRefuse, LedgerMind |
| **Chainlink** · Best Confidential Workflow | Deflow, Sovereign |
| Chainlink · Automated Liquidation Protection | AquaGhost Protocol |
| Chainlink · Best Chainlink-Powered Upgrade | Karwan |
| **ENS** · Best Use of ENSv2 | 1 Herit, 2 Batas, 3 Verdict.eth, runner-up Capsule |
| ENS · ENSv2 into an existing project | SoulVault |
| **Ledger** · AI Agents x Ledger | 1 Harness, 2 GhostKey, 3 ITHACA |
| Ledger · Extend to Ledger (continuity) | 1 SoulVault, 2 Preflight MCP |
| **Privy** | PayGate (best B2B), Sweem (best financial flow) |
| **The Graph** · Composable / Standardized Graph Products | 1 Alpha Markets, 2 Sentinel, 3 OpenBook |
| The Graph · AI Tooling (from scratch) | 1 Covenant, 2 Turnstile, 3 presign + TrueTick |
| The Graph · AI Tooling (continuity) | 1 Aqua0, 2 Hermes v2 |
| **Uniswap** · Best Stack Contribution | ClosingBell-Hook, Otter, TARE; continuity 1 lpTOKEN.fun, 2 Priime |
| **1inch** · Build an Aqua App | 1 Solvent, 2 coldcascade, 3 Superposition; continuity 1 Aqua0, 2 Smile |
| **World** · Selfie Check | ArcAsset, Creance, Automator |
| World · AgentKit Continuity | Novi Corpus, Maneki, hors-luma |

## 3. Projects similar to our idea

A keyword pass over all 812 projects found 324 candidates; reviewed by hand, they fall into three groups.
`★` = finalist, `$` = sponsor prize.

### A. Agent spending caps, limits and revocation — our core mechanism (~60 projects)

The most crowded category of the event. Winners here won **through a sponsor integration** (Ledger,
Bazantic, ENS) or a **business framing**, not the cap itself.

| Project | Angle | Result |
|---|---|---|
| ★ Cordon | Shared task budget across agents + sub-agents (closest to our parent→child tree) | Finalist |
| ★ Novi Corpus | Legal entity + guardian + treasury limits | Finalist, $ World |
| Harness | Ledger tap → container + ENS name + daily on-chain limit; revoke = one tx | $ Ledger 1st |
| GhostKey | Scoped, temporary authority instead of secrets | $ Ledger 2nd |
| LedgerMind | Payment intent: total cap, per-tx cap, time window, merchant allowlist, receipt hash | $ Bazantic |
| NotYet | Budget released on a schedule (timelock-encrypted keys) | $ Bazantic 1st |
| payOrRefuse | Refuse before signing, with reason codes | $ Bazantic |
| Capsule, Batas, Mandate-app | ENS-named agents with on-chain permissions / limits | $ ENS / Bazantic |
| **Capability Descent (ours)** | Capped, attenuable, revocable allowance tree; refusal before pricing | — |
| Warrant, Leash Protocol, Pocket, Bursar, Allowance, AgentKey, revoke.eth, Crew AI, Beast, Arc-Mandate, GOL, Mandate, Handler, RunMandate, SpendVeto, Tollgate-agent, useOmnis, Mandatee, PayBound, Refusal.eth, Arx, Leashh, Leash (×4 more) … | Variations: daily/per-tx caps, vendor allowlists, human approval over a threshold, one-click revoke | — |

### B. Agents paying for data or research per query — our chosen use case

| Project | Angle | Result |
|---|---|---|
| ★ OpenBook | Agent data marketplace, refund on stale data, seller reputation | Finalist, $ Arc + $ Graph |
| ★ OnchainRouter | Catalogue of paid tools; pay per call; no answer, no charge | Finalist |
| Carpool | Agents buy research already done; author royalties; price decays with age; 2-min refund window | $ Hedera |
| Turnstile | Agents buy on-chain analysis per call; wallet limit agent can't raise | $ Hedera + $ Graph 2nd |
| TrueTick | Tokenized-stock fair price sold to agents via x402 | $ Graph 3rd |
| Keryx | Question + USDC budget → research job; BUY/SKIP/CACHE per source; pays cited creators | — |
| Obolos | User sets providers, budgets, max price per item, expiry; agent buys evidence; report + receipts | — |
| Allowance | Agent refuses to pay when data is still fresh or over budget | — |
| AgentDock, FareGate, Toll, BlockTerms, IntentGraph, Matoi, Common | Policy-bound agents buying data | — |

### C. Pay only for what was delivered (escrow, refunds, SLA checks) — research angles §3.1/§3.2

Held, Receipt, Recourse, Verdikt, Reckn, Deadman, x402-validate, jenny-builds, Ledger-of-Work,
ProxyProof402, Best-Before, Recibo. **None won on its own**; the one that won (OpenBook) wrapped
refunds in a clear user story (data buyers) and a market-size pitch.

## 4. What this means for our WHU entry (our inference)

1. **Caps and revocation alone are commodity.** About 60 ETHOnline teams built them, including us,
   and ours didn't place. The WHU mentor's "apply it to a specific use case" matches the evidence.
2. **Our use case is validated, not empty.** Agents buying data and research is exactly what the
   finalists and Hedera winners did (OpenBook, OnchainRouter, Carpool, Turnstile). Judges liked it,
   but we can't claim nobody has done it.
3. **Gaps none of the winners cover (from taglines and descriptions; verify before pitching):**
   - **Charging each purchase to a client or project** (consulting/VC billing). Cordon and Bursar
     track budgets per task or team, but nobody produces a per-client invoice.
   - **Solana.** ETHOnline is EVM/Hedera only; nothing here runs on Solana, and the WHU jury
     requires "a clear role for Solana".
   - **A business buyer instead of a crypto user.** Novi Corpus (legal entity) shows that a
     real-world business framing gets a team into the finals.
4. **Borrow what worked:** OpenBook's opening (market size plus a sharp pain: "stale data, no
   refund"), Carpool's price that falls as research ages and its refund window, OnchainRouter's "no
   answer, no charge", and Cordon's shared budget across sub-agents as the demo story.

## 5. Also relevant

- ETHGlobal Tokyo 2026 (25–27 Sep) finalists include **Omamorei — Agent Payment Firewall** and
  Yohaku (human-in-the-loop agent market). Not reviewed yet.
- The Hedera x402 bounty winners (Aug 2026) are in `research-angles-2026-10-01.md` §1 (Tally = caps).
