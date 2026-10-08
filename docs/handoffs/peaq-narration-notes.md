# Narration notes for peaq demo video

Devin: read these over the recorded clips (live charge, Solana release, peaq Subscan events, machine_status in Claude Code). Plain, factual, no hype. One line is marked for a future recording.

1. **Problem.** Machines can't be trusted with an open wallet. A robot needs either a human to approve every payment, or keys with no limits. Neither scales.

2. **The mandate.** The owner sets the rules once, on chain, as a Fiducia mandate: at most 0.50 USDC per charge, 2 USDC in total, and only this charging pad can be paid.

3. **The robot decides.** After that, the robot's agent decides on its own when to charge. (Record after the ticker is on: it checks its battery every 30 minutes and pays if below 25%, aiming for 80%.)

4. **Proof and release.** The pad signs a meter reading—kilowatt-hours, time, price. The robot releases payment only when it has that signed reading hashed on chain.

5. **The program enforces it.** A charge that breaks the limit—say, 0.60 USDC—is refused by the Solana program itself. We simulate every transaction first, so refused charges never land.

6. **On the ledger.** Each settled charge becomes a revenue event for the pad and an activity event for the robot, written to peaq's EventRegistry. That's the history that shapes the Machine Credit Rating.

7. **Why it matters.** Machines need credit lines, not just limits. Next: with verified revenue on chain, a pad could get a credit rating, downtime insurance paid from escrow, and financing—the charging network could become a credit network.
