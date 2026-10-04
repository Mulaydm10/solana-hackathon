# agents: contract

The Node runtime for everything agent-shaped (PLAN §4–§7). Node-only (it may use `node:` modules), TypeScript, ESM,
same toolchain as the other lanes (`npm test` runs `tsc --noEmit` first, then `node --test`). It depends on
`@deal/core` and `@deal/chain` through `file:` links, like surface. It never runs AI models until PLAN §11: every step
that will later use Claude has a deterministic implementation behind the same interface.

## Layout (one directory per issue, so two agents rarely touch the same files)

| Path | Issue | Owner | What |
|---|---|---|---|
| `agents/src/seller/` | #66 | vedant059 | Listing pipeline: `classify`, `assess`, `price`, `draft`, `publish` |
| `agents/src/custody/` | #67 | vedant059 | Encrypted storage, key sealing to the buyer's wallet key |
| `agents/src/pay/` | #65 | vedant059 | x402-on-Solana client/server helpers (spike result) |
| `agents/src/broker/` | #68 | Mulaydm10 | Capability broker, sealed credentials, egress proxy |
| `agents/src/vm/` | #69 | Mulaydm10 | Per-agent runner (container or `--permission` process) |
| `agents/src/team/` | #70 | Mulaydm10 | Orchestrator, stage loop, mock providers |
| `agents/src/reader/` | #71 | vedant059 | Quarantined reader interface + deterministic reader |
| `tests/agents/injection/` | #71 | vedant059 | Injection corpus, run by the lane's verify (root `tests/<lane>/` convention, like core) |
| `agents/src/index.ts` | first PR | whoever lands first | Re-exports; later PRs add one line each |

The first `agents` claim PR to merge adds `agents/package.json`, `tsconfig.json` and `src/index.ts`. Its `test` script
runs `tsc --noEmit`, then `node --import tsx --test` with **quoted** globs (for example `"test/**/*.test.ts"
"../tests/agents/**/*.test.ts"`), so Node expands them at any depth instead of `sh`. Unit tests live in
`agents/test/`; cross-cutting suites (the injection corpus) in the repo-root `tests/agents/`. The other agent rebases
onto that first PR.

## Interfaces (stable; change only through a design PR to this file)

```ts
// Results, never throws for expected refusals (same rule as the chain library).
type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };

// seller/ (#66)
classify(input: Uint8Array | { endpoint: string } | { blueprint: unknown }): Promise<Classification>;
assess(c: Classification, data: Uint8Array | null): Promise<Ok<{ report: AssessmentReport; reportHash: Uint8Array; grade: "A"|"B"|"C"|"D" }> | Refused>;
// price and draft call core (suggestPrice, validateTerms); publish calls chain (listings.create + attest).

// custody/ (#67)
seal(data: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array; contentHash: Uint8Array };
sealKeyTo(buyerWallet: Address, key: Uint8Array): Uint8Array;          // ed25519 -> x25519
openFor(buyerSecret: Uint8Array, sealedKey: Uint8Array, ciphertext: Uint8Array): Ok<{ data: Uint8Array }> | Refused; // reason "TAMPERED" on a bad key or ciphertext, never throws

// broker/ (#68)
type Capability = { provider: string; resource: string; actions: string[]; expiresAt: number; mission: Address; agent: Address };
grant(req: Capability): Promise<Ok<{ token: string }> | Refused>;      // refuses unless role lists it, mandate live, stage approved
call(token: string, action: string, args: unknown): Promise<Ok<{ result: unknown }> | Refused>; // credential never returned
egressAllowed(host: string, mission: Address): boolean;

// reader/ (#71)
interface Reader { read<T>(untrusted: string, schema: Schema<T>): Promise<Ok<{ value: T }> | Refused> } // no tools, ever

// team/ (#70)
runMission(goal: string, blueprint: Blueprint, opts: MissionOpts): AsyncIterable<MissionEvent>;
```

## Rules

- Untrusted text (listings, endpoint replies, web pages, other agents' output) only ever enters through a `Reader`.
- No module returns or logs a sealed credential or a private key; tests assert it.
- Amounts are bigint base units; all arithmetic in code, never by a model.
- Network calls only through the broker's egress (`egressAllowed`); tests use local stubs.
- Verify: `npm test --prefix agents`. Network or Docker tests are opt-in by env var (`AGENTS_NET=1`, `AGENTS_DOCKER=1`),
  like `DEAL_CHECK_DEVNET` in chain.
