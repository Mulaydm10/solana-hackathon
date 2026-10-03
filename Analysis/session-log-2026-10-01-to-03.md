# Session log, 1–3 Oct 2026

What was researched, decided and corrected, in order. Written for anyone (human or Claude) picking the
project up cold. Details live in the linked files; this is the map.

## 1. Where things are

| Thing | Location |
|---|---|
| This repo | `github.com/Mulaydm10/solana-hackathon` (public). Mac mini: `~/Dhruv/solana-hackathon`. Laptop (omen): `~/competitions/solana-hackathon` |
| Old Hedera project | `github.com/Mulaydm10/ehl-switzerland-hackathon`, Mac `~/Dhruv/ehl_switerland`. ETHOnline 2026 entry "Capability Descent". About 3,900 lines of TypeScript in `core/`, `chain/`, `surface/` |
| Challenge | [Build an MVP with Solana at WHU](https://superteam.fun/earn/listing/build-at-whu), Superteam Germany. Deadline about **5 Oct 2026, 00:00 CEST** (confirm on the listing). Winners 8 Oct. Prizes 1,500 / 1,000 / 500 USDG. Submit: pitch-deck link, public repo, follow @SuperteamDE |
| Live pages (private until shared) | Project explainer https://claude.ai/artifact/KiHwUPCAHNT63wiQHMBg94 · Solana field guide https://claude.ai/artifact/XQ7MGiZ3N7yTzp25UoKKRD · ETHOnline competitor map https://claude.ai/artifact/U7wLrqdEpztHdzHNJdyBw6 |
| Team | Dhruv (`Mulaydm10`, design role, merges) · Vedant (`vedant059`, collaborator, pushes `design/*` branches) |

## 2. Timeline

1. **Found the projects.** The "Swiss crypto" project on the Mac is `ehl_switerland`: capped, revocable
   spending authority for AI agents on Hedera (x402 via Blocky402, ENS identity, MCP tools). There was
   no ETHGlobal Switzerland event; it was entered in **ETHOnline 2026** (online, 4–16 Sep).
2. **Research angles** (`research-angles-2026-10-01.md`). The project's own ADR-0003 already called the
   mechanism saturated. Open problems with evidence: x402 "free shopping" (31 vulnerabilities across 15
   facilitators), `upto` billing that trusts the seller, prompt-injection drains, fleet budgets.
3. **Superteam ideas bank** (521 ideas) read for angles: transaction guards, reputation slashing,
   machine fleets, vendor risk checks, futarchy-controlled agents, agent payroll, pay-per-crawl.
4. **Challenge read and odds** (`use-case-and-value-prop-2026-10-02.md`). Judged on useful idea,
   working prototype, clear role for Solana, potential to grow. Estimate: 55–70% top 3 if one feature
   works live with a clear business deck; scope is the main risk.
5. **Solana building blocks** for agent budgets: `@x402/svm` (exact scheme), PayAI / Coinbase
   facilitators, SPL `approve`/`revoke`, Squads spending limits, the fixed-delegation program
   `De1egAFM…R44`, Token-2022 transfer hooks.
6. **Mentor meeting.** Feedback: the features already exist on Solana, so pick **one specific use
   case**; the value proposition must be **clean and unique**; lead with the **business idea**.
7. **Use case chosen (then):** AI research analysts at consulting/VC firms paying for data per
   question, every purchase billed to the right client. One-liner: "Data by the question, not by the
   subscription."
8. **Solana field guide** published: 18 layers, statuses as of 2 Oct (e.g. 100M CU blocks live,
   P-Token live, Alpenglow expected Oct, Switchboard oracle shut down 25 Sep).
9. **ETHOnline results** (Vedant, `ethonline-2026-winners-and-competitors-2026-10-02.md`): 812
   projects, 8 finalists, 58 prize winners. About 60 teams built agent caps; **Cordon**, a finalist, is
   essentially our mechanism. Capability Descent won nothing.
10. **Post-mortem** (`ethonline-2026-postmortem-2026-10-02.md`): no live demo (link pointed to GitHub),
    mechanism-first pitch with no named user, most crowded category, cap enforced in server memory not
    on-chain, UI deliberately cut, rigour judges could not see.
11. **Vedant's plan** (`what-won-and-how-we-win.pdf`): 16 relevant winners, 14 shared design rules,
    baseline features B1–B8, standout X1–X8 led by "turn off our server, Solana still refuses", a
    2-minute demo and timeline. First technical risk: does `@x402/svm` accept an SPL delegate as payer.
12. **Conclusion on novelty (3 Oct):** what we planned already exists (Cordon, OpenBook, Turnstile,
    Carpool; on Solana the fixed-delegation program and Squads). Only Solana itself and per-client
    billing were left. Enough for WHU, weak as a product.
13. **New direction (3 Oct):** an AI "procurement lawyer" that finds agents and services and puts each
    deal into an on-chain contract built from audited templates. See
    `idea-ai-procurement-lawyer-2026-10-03.md`.

## 3. Corrections made

- `research-angles-2026-10-01.md` §1 and the project explainer said our project was not on the
  ETHOnline showcase and that no winners were published. Both were wrong: it was submitted as
  Capability Descent and did not place, and winners are published as prize badges. Fixed on 3 Oct.
- `strategy.md` says no real Hedera payment ever settled; the old repo's `STATE.md` records three
  testnet settlements on 11 Sep. Left as written; noted here.

## 4. Repo workflow and infrastructure

- Never push to `main`. Use a `design/*` branch and a PR. Docs PRs skip the required `run` check, so
  merging needs the owner override (`gh pr merge --admin`). PR #8 is the standing canary: never merge.
- **CI bug:** `.github/workflows/checks.yml` only accepts `design/*` PRs from OWNER, MEMBER or
  `Mulaydm10`, so every PR Vedant opens fails `lane` (he is COLLABORATOR). Fix: add COLLABORATOR to that
  condition. It is a workflow change, so it needs a canary run.
- **Sync:** a user timer on the laptop (`solana-hackathon-sync.timer`, script
  `~/bin/solana-hackathon-sync`) fast-forwards both checkouts from GitHub every 5 minutes; it never
  overwrites local work.
- Laptop disk is about 98% full (3 GB free) — free space before installing Solana and Node tooling.

## 5. Open items

1. Decide the direction: the procurement-lawyer idea or the analyst client-billing use case.
2. Write code. As of 3 Oct the lanes `core/`, `chain/`, `surface/` are still empty.
3. Test on day 1: `@x402/svm` with an SPL delegate payer; Squads spending limits on devnet.
4. Live, clickable demo and the pitch deck (both required to submit).
5. Fix the CI collaborator rule.
6. Confirm the exact deadline and timezone on the listing.
