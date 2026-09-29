# Teammate onboarding (vedant059)

This repo runs on the agent-bus protocol (`AGENTS.md`). You run your own Claude Code as a worker under
your own GitHub login. Design (Devin) writes the task queue and reviews; Dhruv merges. You never merge
and never push to `main`.

**Prerequisite (Dhruv):** the plugin repo `Mulaydm10/agent-bus-plugin` is private. You need read access
to it before step 2, or the clone fails.

1. `gh auth login` as `vedant059` (needs write on `Mulaydm10/solana-hackathon`; you already have it).
2. Install the plugin and name your device (pick a short unique name, not `mac`):
   ```bash
   git clone https://github.com/Mulaydm10/agent-bus-plugin && cd agent-bus-plugin
   ./bootstrap-device.sh --device <your-device-name>
   ```
   It prints a permissions block for `~/.claude/settings.json`. Paste it yourself, or opt in with
   `--write-permissions` (it backs up first).
3. Clone the project to a durable path (not a temp dir; the registry stores the path):
   ```bash
   git clone https://github.com/Mulaydm10/solana-hackathon && cd solana-hackathon
   ```
4. In Claude Code inside that checkout: `/bus:join`, then `/bus:doctor`. Every command shape must
   report `ok` before you claim anything.
5. `/bus:status` shows the board. `/bus:claim` takes the next eligible `status:queued` issue (or
   `/bus:claim <n>`), makes a worktree, and prints the task and its verify command.
6. Work only inside your issue's lane directory (`core/`, `chain/` or `surface/`, plus `tests/<lane>/`).
   `/bus:verify` then `/bus:pr`. PRs must come from `claim/<issue>`; any other branch name is rejected by CI
   in team mode.
7. Done or stuck: `/bus:release`.

Nothing is claimable until design has joined (`design:` set in `docs/STATE.md`) and queued issues exist.
Node 20+ and npm are needed locally for `npm test --prefix <lane>`.
