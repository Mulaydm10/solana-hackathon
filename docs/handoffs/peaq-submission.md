# peaq "Advance the Machine Economy": submission draft

Status: three-pad version, live since 10 Oct 2026 (agung testnet + Solana devnet). Plan:
`docs/handoffs/peaq-v2-plan.md`. Eligibility for the Germany-only listing confirmed by Dhruv (#226).

## One line

A delivery robot earns, chooses a charging pad, pays into escrow and releases the money only for energy the pad proved
it delivered, inside on-chain limits its owner set once, with every step recorded on peaq.

## Short description (for the form)

One loop, with no human per payment. A simulated delivery robot is paid by a shop for each delivery (escrow on Solana
devnet, plus a revenue event on peaq). Its battery drops; when it needs energy it chooses one of three charging pads
(peaq machines 349, 350, 351) by price and track record, and pays into escrow under a Fiducia mandate its owner set
once: at most 0.50 USDC per charge, 35 USDC in total, only these three pads, enforced by a Solana program. The pad
proves the energy with a signed meter reading, hashed on chain; the robot releases exactly that reading, and both
machines get the event on peaq.

On top of the loop: an MCR-style score computed from each machine's peaq events (modelled on peaq's documented Machine
Credit Rating inputs; not peaq's official MCR, which is not served for testnet machines); parametric downtime
insurance that each pad buys from its own earnings, priced from its score and paid from escrow on a signed outage
proof with no adjuster; and Fiducia Insure, a quote service any peaq machine pays per call over x402.

The machines, battery, driving, deliveries and outages are simulated. Their peaq machine IDs and events (agung
testnet) and their Solana transactions (devnet, test USDC) are real.

## Why it matters

Machines can't be trusted with an open wallet. Today a robot either needs a human to approve every payment, or holds
keys with no limits. Fiducia gives the machine a mandate instead: per-payment and total caps, an allowlist of payees,
an expiry, revocable in one transaction, enforced by a program rather than by a server, and it pays only for proven
work. peaq is the identity and credit layer; Solana is the money layer. Once machines have verifiable histories on
peaq, the same escrow prices and pays insurance for them: the step from a payment rail to finance for machines.

## Fit with the track

- **Two machines, one deal (starter idea):** the robot pays a pad with no human approval, settled on chain.
- **Robotics:** the robot has a peaq identity, a wallet and a mandate; it earns per delivery and pays for its own energy. The page shows earned vs spent on energy.
- **DePIN (energy):** three pads compete; an unreliable or offline pad loses business and its score.
- **DeFi for machines (parametric insurance, starter idea):** policies, premiums, outage proofs, claims and payouts, all on the same escrow.
- **Credit in motion (starter idea):** an MCR-style score recomputed every tick from peaq events, driving pad choice and premiums.
- **New service machines pay for (adapter starter idea):** Fiducia Insure, built in the shape of a robotic.sh adapter (not listed on robotic.sh), paid over x402 on Solana devnet.
- **Physical AI:** not claimed. Claude can take the robot's decisions when a model key is set, capped in code; production has no model key.

## Technical implementation

- A deployed Solana program enforces the mandate (`OverPerTxCap`, `OverMandateCap`, `PayeeNotAllowed`).
- Escrow released on the hash of a signed meter reading; insurance on the same escrow (deliver, claim, refund), no program change.
- Real peaq machine identities, bonded, with real events; scores read from the EventRegistry's logs.
- Heartbeats signed in peaq's message format; the insurer verifies every outage proof before any payout.
- Every transaction is simulated before it is sent; tested against the real program in LiteSVM.

## Honest limits

- Self-reported peaq events (trust level 0): peaq can't verify a Solana transaction, so each event carries the Solana signature.
- MCR-style, not MCR. Earned vs spent, not profit. No Physical AI claim. Test money only.
- From 10 to 12 Oct a server bug (two signer objects for the robot) made charges to pads B and C fail in simulation; nothing was sent. Fixed in #295.

## Links

| | |
|---|---|
| Live demo | https://fiducia-orpin.vercel.app/machines |
| Repository | https://github.com/Mulaydm10/solana-hackathon (README section "Machine economy (peaq track)") |
| Fleet mission (Solana devnet) | https://explorer.solana.com/address/FLPoVGNteR6wXJMye65FEo4MFDMJc9QAHDp5syEbwTey?cluster=devnet |
| peaq machine IDs | robot 348; pads 349, 350, 351 (agung testnet, 1.0 IdentityRegistry, bonded) |
| A delivery the robot was paid for | https://explorer.solana.com/tx/663MmWzA5AHa7cZu9uB9QZnmhfyStv7irpNiS1nqQZVdxVCMeY1yLUqupYHDjpNVKnd6mYkJc9qVYTjHVBRLAYGm?cluster=devnet · peaq https://agung-testnet.subscan.io/tx/0x7a7154fc7f8b627cb75758410b8f53240f3a228b557bbfac706403495d385bbc |
| A charge the robot chose and paid | https://explorer.solana.com/tx/2d4TDBT42MSKYvEzyqeVQbAkVqDBvGoN44Yq8EJ7BpXWFnH2fvkKqgkonVHhxwQmeiH4Zpy6tD1LXxNghHST6anm?cluster=devnet · pad https://agung-testnet.subscan.io/tx/0x6e9ffd2ad68c91da606ff4bf6224b7f1fdd4ba616f715a201c6ab8684e3a3241 · robot https://agung-testnet.subscan.io/tx/0xb087d6d3cc07d95726d9dcddd6679c3b57d559112d2b475f7c228bc5de40b8ec |
| Insurance: outage paid | pad C, 12 Oct: claim https://explorer.solana.com/tx/36dvnYeqzkckenoa2g4Yv1XHifydTbyQoxPzNohXy5guAb5SMJTcLzdaq11FsazA3yHQ5SMwyDAm7Cmc4Pywc16J?cluster=devnet · peaq outage event https://agung-testnet.subscan.io/tx/0x36fb64f098844878daa9cdeca88436892fc8c37d461dd42cba3cd09fa799b3e4 · payout https://explorer.solana.com/tx/67LGhhHCuZGbkLRYbUeKHJT4VHgLUpxPH9fSR862FsTsFnhkJQp3CuhU1nCszYrEXfBRKoy8Av2Fv7C1ndvHgPF7?cluster=devnet |
| Insurance: no outage, cover refunded | https://explorer.solana.com/tx/4G5GbfRazYsb5DnXWUH8GM3h61X63dydA1MrBorMM6KypiXJ2NJBowhR39Zqe8zt6sKegAA8e39u8kRsypRStEW?cluster=devnet |
| Fiducia Insure (x402) | manifest https://fiducia-orpin.vercel.app/api/machines/service/manifest · a paid call https://explorer.solana.com/tx/5exS9vgTxc2UkLiov3pBUXgbmXcpsY7Qckj1G9Ebnc1n8afKc9MjaDqTQKgjfKJ2PdioTXbv1mfdULhKbHLjBUU7?cluster=devnet |
| peaq network | agung testnet (chain 9990), EventRegistry `0x2DAD8905380993940e340C5cE6d313d5c2780040` |
| Video (2 to 3 min) | to be recorded on the three-pad version; narration by Devin |

## Video outline (2 to 3 min)

1. The problem: machines can't be trusted with an open wallet (10 s).
2. The owner's rules, on chain: 0.50 per charge, 35 total, three pads (15 s).
3. The robot earns: a delivery, its release and peaq event (20 s).
4. The robot chooses a pad and charges: the reason, deal → signed meter reading → released → peaq events (40 s).
5. A pad goes offline: heartbeats stop → outage proof → insurer check → payout (35 s).
6. Scores and earned vs spent; Fiducia Insure paid per call over x402 (20 s).
7. `machine_status` from Claude Code, and what's next (15 s).
