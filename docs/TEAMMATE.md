# Teammate onboarding (vedant059): written for your Claude Code to read and follow

This repo runs on the agent-bus protocol. **`AGENTS.md` is the whole protocol**, and every step in it is a plain `gh` /
`git` command; no plugin is needed. Claude: read `AGENTS.md` in full, then `docs/PLAN.md` (what we are building and in
what order), then set yourself up as below. The first time, follow the **worker handshake** issue (label `human`, title
`worker handshake: vedant059`) before claiming anything.

## Roles on this repo

- **Design:** Dhruv's Claude Code on `mac` (login `Mulaydm10`). Writes the task issues, reviews PRs, owns `AGENTS.md`,
  `docs/` and `contracts/`.
- **Worker:** you (login `vedant059`).
- **Both build.** On Dhruv's instruction (4 Oct 2026) design also claims lane issues. The claim ref is the lock, so two
  agents never hold the same issue. The plan is divided by **GitHub assignee**: pick only queued issues assigned to
  you (`gh issue list --label status:queued --assignee @me`), in the usual order. Issues assigned to the other agent are
  skipped unless design reassigns them.
- **Human:** Dhruv merges. You never merge and never push to `main`.
- **Reviews go both ways.** Design reviews your PRs. You review design's PRs (`design/*`) and design's claim PRs, by
  commenting `reviewed at <full head sha>` after reading the diff and the CI checks. A merge needs a non-author review
  that names the current head sha.

## Lanes

| lane | directory | what it is |
|---|---|---|
| core | `core/` | Chain-agnostic, pure logic: deal terms, and per PLAN §3 reputation score, listings, pricing, blueprints, messages |
| chain | `chain/` | Solana program `deal_escrow` (Anchor) plus the TS deal library; tests run the program in LiteSVM |
| surface | `surface/` | The v2 demo (Express plus a proof panel), live on devnet |
| web | `web/` | The marketplace site (Next.js, Vercel later) |
| mcp | `mcp/` | The `npx` MCP package for agents |
| canary | `canary/` | Standing post-merge canary (#4) and pre-merge canary; worker-held |

`agents/` (PLAN §4 and §6) is planned and will be added as a lane by a design PR. Interfaces are in `contracts/<lane>.md`.
Shared code in core and chain must stay browser-safe.

## One-time setup

1. `gh auth login` as `vedant059` (you already have write access).
2. Clone to a durable path: `git clone https://github.com/Mulaydm10/solana-hackathon`.
3. Name your device once: `git config --global device.id <short-name>` (not `mac`). Your worker id is
   `<device>/<first 8 chars of your session id>`.
4. Install Node 22+ and npm, and Python 3 with pytest (canary lane). Run `bash docs/setup.sh` from the repo root, then
   every lane's verify from `docs/verify.txt`.
5. The chain lane runs a committed program binary (`chain/program/deal_escrow.so`), so Rust and Anchor are only needed
   to change the program itself.
6. Pre-allow the bus commands in `~/.claude/settings.json` (a worker blocked on a prompt looks dead to everyone):
   `Bash(gh api:*)`, `Bash(gh issue:*)`, `Bash(gh pr:*)`, `Bash(git fetch:*)`, `Bash(git push:*)`, `Bash(git worktree:*)`.

## Loop (see `AGENTS.md` for the exact commands and rules)

1. **Pick.** Look at open issues labelled `status:queued`.
   - Skip any with a live `claim/<n>` branch or an open `blocked-by:` issue.
   - Order: `prio`, then oldest, then lowest number.
   - Skip `lane:canary` unless asked for it by number.
2. **Claim.** Create `refs/heads/claim/<n>` from `main` via the refs API.
   - 201 = yours. 422 = taken, so pick another.
   - Then comment `claimed by <worker-id> at <ISO-8601>` and set the label `status:claimed`.
3. **Work.** Use a worktree on `claim/<n>`, and touch only the issue's lane directory plus `tests/<lane>/`. For anything
   that crosses lanes, comment on the issue instead.
4. **Verify.** Run the lane's command from `docs/verify.txt`, as it is on `main`.
5. **PR.** Open it from `claim/<n>`.
   - Title: `#<n>: <summary>`.
   - The body links the issue but never says `Closes #n`.
   - Set the label `status:review`.
   - CI rejects any other branch name.
6. **Stuck or stopping.**
   - Rename `claim/<n>` to `abandoned/<n>-<device>-<unix-ts>`; never delete it.
   - Put the issue back to `status:queued`.
