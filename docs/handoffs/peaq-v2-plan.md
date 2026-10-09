# peaq v2: one machine economy around one loop

The peaq track rewards one working economic mechanism with peaq at its centre, not five half-features. v1 is live: a
simulated robot (peaq machine 348) decides on its own and pays a simulated charging pad (349) on Solana devnet escrow,
settled on a signed meter reading, with peaq events (agung). v2 deepens that loop until it covers every scope area
peaq names, and every new number comes from peaq events or on-chain state.

**Story:** a charging network where machines earn, choose who to buy energy from, and insure themselves against
downtime, all priced from their peaq history and settled on chain with no human in the loop.

| Scope area (listing) | v2 piece | Issue |
|---|---|---|
| Robotics: earn and pay for itself | the robot is paid per delivery (escrow) and gets peaq revenue events | #270 |
| M2M commerce | robot pays pads per kWh on a signed meter reading (v1) | live |
| DePIN (energy) | three pads with their own prices, uptime and score; an unreliable pad loses business | #269 |
| Physical AI | the robot picks its supplier (Claude when the key is set; capped in code) | #269 |
| DeFi for Machines | the pad buys daily downtime insurance from its own revenue, priced from its score; a signed outage proof pays out with no adjuster | #271 |
| Credit ("Credit in motion") | an open MCR-style score from peaq events, recomputed live, driving premium and pad choice | #267 |

## Mechanisms

**Score (#267).** Read each machine's events from the EventRegistry's logs (topic 1 = machine id). Score 0–100 from
peaq's documented MCR inputs: bond, revenue consistency, activity depth, tenure, freshness, negative events. It is
labelled "MCR-style score, computed by Fiducia from peaq events" because peaq does not serve MCR for testnet machines.

**Heartbeats (#268).** Each tick, every online pad signs a heartbeat in peaq's own message format
(`machineId: <id>\nsentAt: <unix>`, EIP-191 with the pad's peaq key). A gap longer than `outageAfterSecs` is an outage;
the outage proof (canonical JSON, sha256) names the last valid heartbeat and the gap. Pads are simulated, so an outage
is simulated too (the owner switches a pad off); the proof, the payout and the peaq event are real.

**Insurance (#271), no program change.** One policy = one escrow deal: buyer = an insurer agent (coverage in escrow),
seller = the pad, verifier = an independent verifier, deadline = term end. The pad pays the premium (SPL transfer from
its own earnings) priced from its score. On an outage the pad `submit_delivery`s the outage-proof hash; the insurer
checks the proof and challenges only an invalid one; after the review window anyone calls `claim` and the coverage pays
the pad. No outage by term end: anyone calls `refund` and the coverage returns to the insurer. Each outage is also a
negative peaq event for the pad, so it lowers the score and raises the next premium.

**Network (#269).** Three pads (349 + two new agung machines) with different prices. Eligible = online, in the robot's
mandate payee list. Choice = lowest risk-adjusted price (score); the reason is shown. With a model key, Claude picks
among eligible pads only; code recomputes and caps the amount.

**Earnings (#270).** A simulated shop agent pays the robot 0.50 USDC per delivery on escrow (create_deal → accept →
deliver a signed drop-off record → release). A delivery drains the battery, so earning and energy are coupled; the page
shows earned vs spent on energy.

## Order

Wave 1 (parallel, agents lane, separate files): #267, #268, #269, #270. Wave 2: #271 (needs #267 #268), #272 setup
script. Wave 3: #273 web server tick, then #274 page and #275 MCP. Then design: run setup on agung + devnet, deploy,
judge intro, README, submission, video.

## Honesty rules (unchanged)

Machines, battery, driving, deliveries and outages are simulated and labelled so; payments, escrow, proofs and peaq
events are real. Never write "mainnet" in user-visible text. The score is "MCR-style", never "peaq's MCR".
