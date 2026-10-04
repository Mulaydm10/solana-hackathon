# STATE.md — current shape of the project (written by design only, via `claim/state`)

## Purpose
Build for the Superteam Germany "Build an MVP with Solana at WHU" hackathon: an AI procurement layer. A buyer (person or agent) states a need; the AI finds a service and fills in an audited deal template; a Solana program (`deal_escrow`, devnet) holds the USDC and pays on delivery or refunds after the deadline. MVP = one template (pay on delivery), end to end, live on devnet. TypeScript/Node + Anchor. Idea: Analysis/idea-ai-procurement-lawyer-2026-10-03.md; interfaces: contracts/.

mode: team
attention: active
merge: human
design: Mulaydm10
<!-- design: Dhruv's Claude Code session on `mac`, under the Mulaydm10 login (no Devin on this repo). Format: design: <login>   set by design on join, via claim/state; absent = repo not live, workers report "no design node" -->
<!-- mode: solo | team.  attention: active | paused (workers' cross-repo pick order skips paused repos; design sessions do not wake).
     merge: human | auto-lane (auto-lane = you give up human code review of lane PRs for throughput; design sets auto-merge on green + approved claim PRs; refused unless main requires lane+run; design/* always human).
     CI reads these from the live tip of the base branch and workers from `main`, never from a PR head: a PR must not relax the enforcement it is judged by. -->

## Lanes

| lane | directory | purpose | contract |
|------|-----------|---------|----------|
| `lane:canary` | `canary/` | two standing issues: post-merge canary (permanent claim, draft PR) and pre-merge canary (transient claim per workflow PR) | — |
| `lane:surface` | `surface/` | HTTP API + web demo of Ask -> Find -> Terms -> Lock -> Deliver -> Settle; Claude drafts terms (refusals are normal results) | `contracts/surface.md` |
| `lane:chain` | `chain/` | Solana program `deal_escrow` (Anchor) + TS client; tests run the compiled program in LiteSVM | `contracts/chain.md` |
| `lane:core` | `core/` | chain-agnostic deal terms: validation, terms hash, plain-language summary; no network or chain code | `contracts/core.md` |
<!-- bootstrap.sh appends one row per lane you pass it; design edits after that. A lane may be a nested path (`src/01_ingest`); no lane may be a prefix of another. -->

## Verify environment
`docs/setup.sh` (design-owned; CI runs the copy on `main`; changing it needs a canary like any workflow change). Python + `requirements-dev.txt` for the canary only; TypeScript/Node per lane (`npm test --prefix <lane>`; a lane without `package.json` is skipped at install and gets one in its first PR). Workers run the same script once per worktree.
<!-- change both this line and requirements-dev.txt / docs/verify.txt if the project is not Python -->

## Decisions
- Lock = `claim/<n>` ref via git refs API (201/422). Labels advisory; refs beat labels.
- Lane + per-lane verify (`docs/verify.txt`) are CI jobs in one workflow (`checks.yml`: lane → resolve → run).
- Reclaim renames to `abandoned/…`; resume only on green CI + passing verify.
- Worker id = device/session; sessions hold claims, machines don't. Worktree per claim.
- Contracts in `contracts/<lane>.md`, design-owned.

## Known gaps
- Branch protection on `main` requires `lane` + `run` (enforce_admins off, so the owner can still override). Applied by bootstrap on the public repo.
- Lane `package.json` manifests are read from the PR head, not BASE (see docs/setup.sh). Team mode is untested upstream.
- Design is a human login (Mulaydm10), not a bot: repo variable `DESIGN_BOT=Mulaydm10`. Design and merge are the same person, so the only independent review of a design PR is the worker's (vedant059).
- The standing canary claim (#4) is held by Mulaydm10, i.e. design — a deviation from "canaries are worker-authored". Its PR is on `claim/4`, so CI still judges it on the lane path.
- Actions minutes are one pool per repo; check quota before a team event.

## Log
- 2026-09-29: repo created from agent-bus-template; bootstrap run (mode=team).
- 2026-09-29: no Devin on this repo. Design = Dhruv's Claude Code on `mac` (Mulaydm10); the only worker = vedant059. Omen is not in this project's pool. Teammate setup is plugin-free: vedant059 follows AGENTS.md via docs/TEAMMATE.md.
- 2026-10-04: direction set to the AI procurement layer (pay-on-delivery escrow program). On Dhruv's instruction the design session also builds the first lane tasks (deviation from "design never claims lane tasks"); vedant059 reviews.
