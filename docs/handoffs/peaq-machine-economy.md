# Handoff: peaq "Advance the Machine Economy" track (Crypto World's Fair, Germany side track)

Author: Devin (planning). Implementer: Claude (design session). Owner: Dhruv (merges).
Status: plan only. Nothing here is built yet.

## 0. Ground rules (from Dhruv)

- **Build on top of the live deployment. Add, never subtract.** No existing page, route, MCP tool, env var,
  test or program instruction is removed or changes behaviour. The current demo (`/hire`, "Try the demo",
  `DEMO_BUYER_KEY`, the clean mission evidence) must keep working exactly as today.
- **No change to the Solana program.** Everything below uses instructions that are already deployed on
  `CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV` (devnet).
- Existing pages keep their look. The one new page uses the Atelier tokens already in `web/app/globals.css`.
- Honesty: machines are **simulated**, and every screen and doc says so. Their peaq IDs, peaq events and
  Solana transactions are real. Never claim a credit rating moved if it did not.
- Follow AGENTS.md: lane issues, `claim/<n>` branches, one lane per PR, `docs/verify.txt` passes.

## 1. The track, in one paragraph

Sponsor: peaq. Prizes 1,000 / 700 / 300 USDT + Microducks (listing shows 3,995 USDT total). Germany-only listing.
Deadline about 2026-10-13 (6d 13h from 2026-10-06 17:37 UTC; confirm on the listing). Winners by 2026-10-27.
They want machines that earn, pay each other, build credit and get financed. Starter ideas include
"two machines, one deal: a drone pays a charging pad, settled on-chain without human approval".
A simulated machine is valid if it **activates a real peaq machine ID and reports real events**.
Judged on: innovation, technical implementation (and fit with peaq's principles), impact, clarity, and
machine-economy focus. Scores badly: peaq tacked on, a generic dashboard without an economic mechanism,
a deck instead of a working demo, a README that assumes context, five half-built features instead of one.

## 2. The pitch (one loop, nothing else)

**"Charge on delivery." A delivery robot's AI agent buys charging from a charging pad. The robot's owner sets
the rules once (a Fiducia mandate: max 0.50 USDC per charge, 2 USDC per day, only this pad). After that the
robot pays on its own, no human per payment. The USDC sits in escrow until the pad proves the kWh it delivered
(a signed meter reading, hashed on chain). An over-limit charge is refused by the Solana program
(`OverPerTxCap`). Every settled charge is written to peaq as a revenue event for the pad and an activity
event for the robot, linked to the Solana signature, so the machines build the credit history peaq's
Machine Credit Rating (MCR) is computed from.**

Why this is ours and not "peaq tacked on":
- peaq's own agent-spending feature (Scale / Machine Markets: per-transaction limit, daily limit,
  allow/deny lists, escrow) is **paused** in their docs today, and its limits are enforced by peaq's
  orchestrator server. Fiducia enforces the same kind of limits **in a Solana program**. Frame it as
  complementary ("the on-chain enforcement layer for machine agents"), never as a replacement.
- peaq is the identity and credit layer (machine ID, events, MCR); Solana + Fiducia is the money layer
  (mandates, escrow, settlement). Each chain does what it is for.

## 3. Facts checked in peaq's docs (2026-10-06)

Sources: https://docs.peaq.xyz/llms.txt and the pages it links.
- Machine IDs: Economics 2.0 `activateMachine` (JS `@peaqos/peaq-os-sdk`, Python `peaq-os-sdk`, CLI
  `peaq-os-cli`). Deployments `peaq-mainnet` and `agung-2026-08-28` (agung testnet, chain ID 9990).
- **Solana-homed machines are paused** ("A peaq contract upgrade removed the reservation call ... activate new
  machines on peaq"). So our machines are homed on peaq and pay on Solana.
- Events: `submitEvent` to `EventRegistry`; type 0 revenue (minor units, `currency` e.g. `USD`), type 1
  activity (`currency` ""). `trustLevel` 0 self-reported, 1 on-chain verifiable (backed by a tx hash),
  2 hardware-signed. Fields include `sourceChainId`, `sourceTxHash` (bytes32), `rawData` (hashed by SDK).
  peaq uses chain id `5` for Solana in its home-chain fields; **verify the right `sourceChainId` for a Solana
  source** before relying on it.
- EventRegistry addresses: mainnet 2.0 `0xA1e7F1d7B24dAb55Dc92491e6d9B89F6E925Ad1e`; agung docs list
  `0x2DAD8905380993940e340C5cE6d313d5c2780040` (1.0 table). **Verify which registry accepts agung 2.0 machine
  IDs** (wrong registry reverts `MachineNotFound`).
- MCR: public `GET https://mcr.peaq.xyz/mcr/did:peaq:<decimal machine id>`, no auth. Serves mainnet 2.0
  machines. **"Agung has no paired 2.0 MCR."** New machines show `Provisioned` until they have a sustained
  event history, so a rating will not visibly rise during a demo.
- Costs: bond is per tier, paid in PEAQ (onboarding quickstart: "40 USD per Pro machine per year"); gas from
  the 2FA Gas Station (`https://depinstation.peaq.xyz`, funds peaq wallets). Agung needs agung PEAQ.
- Public RPCs: mainnet `https://peaq.api.onfinality.io/public`, agung `https://peaq-agung.api.onfinality.io/public`.

## 4. Network decision (ask Dhruv before step B)

| Option | What it gives | Cost / risk |
|---|---|---|
| **A. agung testnet (default)** | Real machine IDs and real events, free | No MCR on agung: show "MCR not served on testnet" honestly, show event count instead |
| **B. peaq mainnet** | MCR endpoint answers (`Provisioned`), strongest proof | Bond + gas in real PEAQ (two machines, small amount); someone must fund and hold the keys |

Recommendation: build against A, keep the network a config value, switch to B for the recorded take only if
Dhruv funds it. Solana side stays **devnet** either way.

## 5. What already exists (reuse as is)

| Need | Existing piece |
|---|---|
| Owner sets rules once | `create_mission` + `add_mandate` (cap, `per_tx_cap`, `payees`, `stage_mask`, `expires_at`) + one `approve_stage(0)` |
| Robot pays with no human | `agent_open_deal` signed by the robot's agent key, limited by `check_spend` |
| Over-limit refused | `OverPerTxCap` / `OverMandateCap` / `PayeeNotAllowed` (simulate before send, like the current demo) |
| Pay on proven delivery | `submit_delivery(delivery_hash, invoice)` by the pad, `agent_release(expected_delivery_hash)` by the robot |
| Pay-per-call alternative | x402 `agents/src/pay/{gate,payer}.ts` (robot buys a "charge slot" API) - optional, not needed for the loop |
| Server-held devnet signer pattern | `web/lib/demo.ts` + `web/lib/demo-server.ts` (fail-closed limits, rate limits, key never leaves server) |
| Chain client | `@deal/chain` (`chain/src`) generated instructions and fetchers |
| Agent via Claude Code | MCP server in `mcp/` |

## 6. What to build (all additive)

Open one queue issue per lane (design does this). Suggested order and sizes:

### B1. agents: `agents/src/machines/` (medium) - lane `agents`
- `meter.ts`: pad meter reading `{padId, robotId, kWh, startedAt, endedAt, priceMicroUsdc, nonce}`, canonical
  JSON, ed25519-signed by the pad key; `deliveryHash = sha256(canonical reading)`. Pure, unit-tested.
- `peaq.ts`: thin wrapper over `@peaqos/peaq-os-sdk` (+ `viem`): `activateMachine` (script use only),
  `submitRevenueEvent(pad, settlement)`, `submitActivityEvent(robot, settlement)`, `queryMcr(machineId)`.
  Event `rawData` = canonical JSON `{solanaCluster:"devnet", program, deal, releaseSignature, deliveryHash,
  amount}`; `sourceTxHash` = 32-byte hash of the Solana signature (the signature is 64 bytes; full value is in
  `rawData`); `trustLevel = 1`. Revenue `value` in USD cents (1 USDC = 100), `currency "USD"`; say in docs that
  devnet USDC is test money.
- `charge.ts`: the loop as a function with injected deps (chain send/simulate, pad signer, peaq client), so it
  is testable without network: open deal -> pad submits delivery -> robot releases -> peaq events. Returns
  every signature/tx hash or a typed refusal. Idempotent per charge id (never write a peaq event twice for one
  release; never release twice).
- Tests: meter signing/hash, refusal paths, idempotency, event shape (currency/value rules from peaq docs).

### B2. scripts (small) - design-owned path, e.g. `scripts/machines/`
- `activate.ts`: activates the two simulated machines on the chosen peaq network, prints machine IDs only.
- `fleet-setup.ts`: with a **new devnet-only owner key** (`MACHINE_OWNER_KEY`, NOT `DEMO_BUYER_KEY`, so the
  existing demo's daily policy is untouched): init policy, create the "fleet day" mission (budget e.g. 3 USDC,
  one stage), add the robot's mandate (cap 2 USDC, per-tx 0.50 USDC, payees = [pad wallet], 6 h expiry),
  approve stage 0 with `plan_hash = sha256(fleet rules doc)`. Prints addresses and signatures only.
- Keys: robot agent key, pad key, owner key, peaq machine keys. Devnet/testnet only, env or local files,
  never committed, never printed.

### B3. web: `/machines` page + API (medium) - lane `web`
- New `web/app/machines/page.tsx` (Atelier tokens, existing fonts) and `web/app/api/machines/charge/route.ts`
  (POST: run one charge; body may ask for an over-limit amount to show the refusal), `.../status/route.ts`.
- Server wiring like `demo-server.ts`: new env vars `MACHINE_OWNER_KEY`, `ROBOT_AGENT_KEY`, `PAD_KEY`,
  `PEAQ_RPC_URL`, `PEAQ_DEPLOYMENT`, `PEAQ_EVENT_KEY`, `ROBOT_MACHINE_ID`, `PAD_MACHINE_ID`. Missing env =>
  page shows "machine demo not configured" (fail closed), nothing else on the site changes.
- Same protections as `demo.ts`: fixed amounts (refuse anything above per-tx cap before signing *except* the
  explicit "try over-limit" button, which only simulates and shows the program's refusal), per-IP and daily
  rate limits.
- Page content, top to bottom: two machine cards (name, "Simulated machine", peaq machine ID with explorer
  link `https://machines.peaq.xyz/...`, Solana wallet, MCR or "not served on testnet"); the owner's rules
  (from chain, not hard-coded); buttons "Charge 0.40 USDC" and "Try 0.60 USDC (over limit)"; a timeline per
  charge: deal opened -> meter reading signed (hash) -> delivered -> released -> peaq revenue event ->
  peaq activity event, each with a Solana Explorer or peaq link; running totals (charges, kWh, USDC, events).
- Add one `NAV` entry `{ href: "/machines", label: "Machines" }` (append only) and a route test entry.

### B4. mcp (small, optional) - lane `mcp`
- `machine_status` tool (read-only): machine IDs, mandate left, last charges, peaq event count / MCR.
  Lets Claude Code narrate the robot's state in the video. Skip if time is short.

### B5. docs + submission (small) - design-owned
- `README.md`: add a "Machine economy (peaq track)" section (do not remove anything): what it is, 5-minute
  try path, "for judges, where to look", devnet + agung/mainnet disclosure, simulated-machine disclosure.
- 2 to 3 minute video: problem (machines can't be trusted with an open wallet) -> rules set once -> robot
  charges itself -> over-limit refused -> escrow released on meter hash -> peaq events appear -> why it
  matters (credit from verified revenue, next: downtime insurance paid from escrow using heartbeats).
- Submission text: English, machine-economy contribution in the first sentence, links to live page, repo,
  Explorer and peaq records.

## 7. Acceptance criteria (definition of done)

1. On the live site, `/machines` runs one full charge: real devnet deal open, `submit_delivery`, `agent_release`
   signatures, and real peaq event tx hashes for both machines, all linked.
2. The over-limit button shows the program's `OverPerTxCap` refusal; nothing lands on chain.
3. Two real peaq machine IDs (agung or mainnet) shown and linked.
4. Every existing test still passes; `docs/verify.txt` passes per lane; existing demo still works (run it once).
5. No secret in the repo, logs or API responses.
6. Every screen says "Simulated machine"; no claim that MCR rose unless the API shows it.

## 8. Risks

- **Eligibility:** Germany-only listing. Dhruv confirms the team qualifies before submitting.
- peaq SDK on Vercel: `@peaqos/peaq-os-sdk` + `viem` server-side only; check bundle/runtime (Node runtime route).
- Agung gas: Gas Station may only fund mainnet; if agung PEAQ can't be obtained, stop and ask (do not switch
  to mainnet without Dhruv).
- `sourceChainId` / registry address for agung 2.0 are unverified (see section 3).
- Time: about 4 to 5 working days. Cut B4 first, then the running totals. Never cut the refusal or the peaq link.
- Scope creep: do not add insurance, NFT trading or a fleet dashboard. One loop.
