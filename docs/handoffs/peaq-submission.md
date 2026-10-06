# peaq "Advance the Machine Economy": submission draft

Status: draft. Fill in the two machine IDs and the first live charge's links once `activate.ts` has run (#226). The
plan is `docs/handoffs/peaq-machine-economy.md`. Dhruv confirms eligibility (Germany-only listing) before submitting.

## One line

Fiducia lets a machine pay another machine on its own, inside on-chain spending limits its owner set once, and pays
only for energy the other machine proved it delivered, with every settled charge recorded on peaq.

## Short description (for the form)

A delivery robot's AI agent buys charging from a charging pad. The owner sets the rules once, as a Fiducia mandate on
Solana: at most 0.50 USDC per charge, 2 USDC in total, only this pad. After that the robot pays with no human per
payment. The USDC waits in escrow until the pad proves the energy it delivered (a signed meter reading, hashed on
chain), and the robot releases exactly that reading. An over-limit charge is refused by the Solana program itself.
Each settled charge is written to peaq as a revenue event for the pad and an activity event for the robot: the
history peaq's Machine Credit Rating is built from.

The machines are simulated. Their peaq machine IDs and events (agung testnet) and their Solana transactions (devnet)
are real.

## Why it matters

Machines can't be trusted with an open wallet. Today a robot either needs a human to approve every payment, or holds
keys with no limits. Fiducia gives the machine a mandate instead: per-payment and total caps, an allowlist of payees,
an expiry, revocable in one transaction, enforced by a program rather than by a server. peaq's own agent-spending
feature (limits, allowlists, escrow) is enforced by peaq's orchestrator and is currently paused; Fiducia is the
on-chain enforcement layer for the same idea. peaq is the identity and credit layer; Solana is the money layer.

Next: downtime insurance paid from escrow on heartbeat events, and credit lines priced from the verified revenue.

## Fit with the judging criteria

- **Machine economy focus:** two machines, one deal, settled with no human per payment. That's the track's own starter idea, plus the limits that make it safe.
- **Technical implementation:**
  - A deployed Solana program enforces the mandate (`OverPerTxCap`, `OverMandateCap`, `PayeeNotAllowed`).
  - Escrow is released on the hash of a signed meter reading.
  - Real peaq machine identities, bonded, with real events.
  - Every transaction is simulated before it is sent.
  - Tested against the real program in LiteSVM.
- **Honesty:** the events are self-reported (trust level 0), because peaq can't verify a Solana transaction. Each event carries the Solana signature so anyone can check it. No credit-rating claim is made for testnet machines.
- **One working loop,** not five half-built features.

## Links (fill in)

| | |
|---|---|
| Live demo | https://fiducia-orpin.vercel.app/machines |
| Repository | https://github.com/Mulaydm10/solana-hackathon (README section "Machine economy (peaq track)") |
| Fleet mission (Solana devnet) | https://explorer.solana.com/address/7hTQTkkZ5hGrVvdsGXm3kqG4RB3u7LiN62WdmUDssYn6?cluster=devnet |
| Robot peaq machine ID | _after activate.ts_ |
| Pad peaq machine ID | _after activate.ts_ |
| First settled charge (Solana release) | _after the first live charge_ |
| Its peaq revenue / activity events | _after the first live charge_ |
| Video (2 to 3 min) | _to record_ |

## Video outline (2 to 3 min)

1. The problem: machines can't be trusted with an open wallet (10 s).
2. The owner's rules, on chain: 0.50 per charge, 2 total, only this pad (20 s).
3. "Charge 0.40 USDC": deal → signed meter reading → delivered → released → peaq events, each linked (50 s).
4. "Try 0.60 USDC": refused by the Solana program, nothing sent (20 s).
5. Click through: a Solana Explorer release and the matching peaq event (30 s).
6. `machine_status` from Claude Code (15 s).
7. Why it matters and what's next (15 s).
