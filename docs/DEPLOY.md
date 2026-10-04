# DEPLOY.md: the one devnet upgrade to deal_escrow v3, then the site and the package

Design-owned runbook for #75. Every step is checked before the next; nothing here is retried blindly.
Mainnet is out of scope (the env schemas refuse it).

## 0. Preconditions

- #62 merged (the last chain PR); `npm test --prefix chain` green on `main`.
- Wallet `FggjxE5Qqg6B842PjZsXJK9HASppZdkfVyWfYFtHHAjn` (upgrade authority) holds **at least 5 SOL**:
  about 1.5 SOL of permanent rent to grow the program from 334 KB to about 630 KB, and about 3.2 SOL for the
  temporary upload buffer (refunded when the upgrade closes it). Top up only at faucet.solana.com signed in with
  GitHub (Dhruv); never loop CLI airdrops (campus IP limits).
- Program keypair: `~/Dhruv/wt-solana-mvp/chain/anchor/target/deploy/deal_escrow-keypair.json` (not in git).

## 1. Build and pin

```sh
NO_DNA=1 anchor build                       # in chain/anchor, PATH with solana + cargo + avm
cmp chain/anchor/target/deploy/deal_escrow.so chain/program/deal_escrow.so   # must be identical to main's binary
shasum -a 256 chain/program/deal_escrow.so  # record it in the PR that logs the upgrade
```

## 2. Grow, then upgrade (Solana CLI)

```sh
solana program show -u devnet CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV          # Data Length now
solana program extend -u devnet CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV <bytes>  # new size - old size + 4 KB slack
solana program deploy -u devnet --program-id <program keypair> chain/program/deal_escrow.so
```
If `deploy` fails mid-way, the CLI prints a buffer address and a seed phrase for it: **do not start over**. Resume
with `--buffer <address>` (the buffer holds the SOL), or close it with `solana program close <buffer>` to get the
SOL back. Check `solana program show` before any second attempt.

## 3. Prove it

```sh
node --import tsx chain/scripts/verify-deployed.ts      # deployed ELF == committed binary (sha256)
DEAL_CHECK_DEVNET=1 npm test --prefix chain             # devnet proof tests
```

## 4. One-time chain setup (after the upgrade)

- `set_assessors` with the marketplace's assessor key(s), signed by the upgrade authority. Record the keys in
  `contracts/chain.md`.
- Re-run `npm run setup:devnet --prefix surface` (idempotent): the buyer policy, demo mint and keys still work;
  deals opened under v2 keep settling (they get reputation accounts lazily).
- Token: x402 calls use Circle devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`); move the escrow demo and
  the faucet route to the same mint so buyers hold one token (#88 finding).

## 5. Site (Vercel) and package (npm)

- `web`: Vercel project, env from `web/lib/env.ts` (server keys only as Vercel env vars; the client bundle test
  must pass). Deploy preview first, check every page against devnet, then production.
- `mcp`: needs Dhruv's package name and `npm login`; publish from a clean checkout of `main`; smoke-test with `npx`.

## 6. Afterwards

- Omen demo: move the pinned worktree to the new `main`, copy keys, restart, rerun the proof panel.
- Log the upgrade (slot, binary sha256, extend size, cost) in `docs/STATE.md` and the devnet memory note.
- **Never** remove the upgrade authority without Dhruv's explicit OK: the assessor registry would freeze.
