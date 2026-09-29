# Teammate onboarding (vedant059) — written for your Claude Code to read and follow

This repo runs on the agent-bus protocol. **`AGENTS.md` is the whole protocol**, and every step in it
is a plain `gh` / `git` command — no plugin is needed. Claude: read `AGENTS.md` in full, then set
yourself up as below.

## Roles on this repo

- **Design:** Dhruv's Claude Code on `mac` (login `Mulaydm10`). Writes the task issues, reviews PRs.
- **Worker:** you (login `vedant059`) — the only worker. There is no Devin here.
- **Human:** Dhruv merges. You never merge and never push to `main`.
- Dhruv's `design/*` PRs need a non-author review; you are the only one who can give it, so review
  them when asked (comment `reviewed at <sha>`).

## One-time setup

1. `gh auth login` as `vedant059` (you already have write access to this repo).
2. Clone to a durable path: `git clone https://github.com/Mulaydm10/solana-hackathon`.
3. Name your device once: `git config --global device.id <short-name>` (not `mac`). Your worker id is
   `<device>/<first 8 chars of your session id>`.
4. Install Node 20+ and npm (lanes verify with `npm test --prefix <lane>`), and Python 3 with pytest
   for the canary lane.

## Loop (see `AGENTS.md` for the exact commands and rules)

1. **Pick:** open issues labelled `status:queued`, skipping any with a live `claim/<n>` branch or an
   open `blocked-by:` issue. Order: `prio`, then oldest, then lowest number. Skip `lane:canary` unless
   asked by number.
2. **Claim:** create `refs/heads/claim/<n>` from `main` via the refs API. 201 = yours; 422 = taken,
   pick another. Then comment `claimed by <worker-id> at <ISO-8601>` and set label `status:claimed`.
3. **Work:** in a worktree on `claim/<n>`, touching only the issue's lane directory (`core/`,
   `chain/` or `surface/`) plus `tests/<lane>/`. Anything cross-lane → comment on the issue.
4. **Verify:** run the lane's command from `docs/verify.txt` on `main` (run `docs/setup.sh` first).
5. **PR:** from `claim/<n>`, title `#<n>: <summary>`, body links the issue but **no** `Closes #n`.
   Set label `status:review`. Any other branch name is rejected by CI.
6. **Stuck or stopping:** rename `claim/<n>` → `abandoned/<n>-<device>-<unix-ts>` (never delete) and
   put the issue back to `status:queued`.
