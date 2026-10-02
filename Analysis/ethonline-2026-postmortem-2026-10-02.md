# Why Capability Descent did not place at ETHOnline 2026

_Written 2026-10-02. Compares our showcase entry with projects that placed. Builds on
`ethonline-2026-winners-and-competitors-2026-10-02.md`. Reasons 1–6 are our reading of the evidence._

Our project: [Capability Descent](https://ethglobal.com/showcase/capability-descent-7mmjb)
(repo `Mulaydm10/ehl-switzerland-hackathon`), ETHOnline 2026. No prize, not a finalist.

## Same idea, different result

| | Capability Descent (ours) | [Cordon](https://ethglobal.com/showcase/cordon-vw3kh) (finalist) | [Turnstile](https://ethglobal.com/showcase/turnstile-ovks1) (Hedera prize) |
|---|---|---|---|
| Tagline | "Capped, revocable spending authority for AI agents: real HBAR settles, over-budget is refused" | "Helps AI teams balance performance and cost within a shared budget" | "Pay-per-call onchain analysis for AI agents. Sell the answer, keep the method." |
| Who it is for | Not stated | AI teams running multi-agent systems | Analysts selling insights; agents buying them |
| Live demo | The "Live Demo" link points to the GitHub repo | getcordon.xyz | turnstile.moveseventyeight.com |
| Where the limit is enforced | In the resource server's memory | On-chain contracts (MandateRegistry, TreeVault, ConductRecord) | Wallet limit the agent cannot raise |
| Story | The mechanism | Cost control for teams | A marketplace for analysis |

Cordon built almost exactly our idea (budgets across an agent hierarchy, refusals with feedback,
x402) and reached the finals.

## Why we did not place

1. **No live demo.** "Live Demo" on our showcase links to GitHub. Every finalist and winner checked
   had a working site. Our video was the keyless cut, with no real payments on screen. With 812
   entries, judges decide in seconds.
2. **We described the mechanism, not a customer.** Our tagline says how it works; Cordon's says who
   it helps and why.
3. **Most crowded category.** About 60 teams built spending caps and revocation. Winners added a
   business use (Turnstile, Carpool), hardware security (Ledger winners) or a deep sponsor
   integration.
4. **The cap was not on-chain.** Our allowance lived in server memory and Hedera only settled.
   Cordon enforced limits in contracts, so the chain mattered.
5. **We cut what judges see first.** Per our own decision records:
   - UI and demo work scoped out on purpose (ADR-0005 G-5), the same gap that lost the previous
     hackathon's UI track;
   - Bazantic not done: no account, 0 of 7 qualifying artifacts;
   - ENS revocation never published on-chain (no funded Sepolia account, E-3);
   - `COMPETITION.md` never filled, so the track audit in `TRACKS.md` was never done.
6. **Effort went into rigour judges do not score.** Mirror-node verification, property tests to
   depth 5, the claims ledger and the ECDSA/ED25519 key fix were good engineering but invisible in a
   three-minute demo. ADR-0005 had already noted that real data, a reviewed-PR trail, honest docs and
   a polished video did not decide the previous loss.

**In one line:** we built the most correct version of the most common idea, and presented it as an
engineering spec with no live demo and no named user. The finalists presented the same idea as a
product.

## What changes for WHU

- A live, clickable demo comes before anything else.
- Lead with the customer: consulting firms billing AI data costs to clients, not "capped, revocable
  delegation".
- Enforce the limit on Solana itself, so the chain is necessary, not just the settlement rail.
- Keep the rigour, but behind the demo and the pitch, not instead of them.
