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
| `agents/test/injection/` | #71 | vedant059 | Injection corpus, run by the lane's verify |
| `agents/src/machines/` | #227 | unassigned | peaq machine track: signed meter reading, charge-on-delivery loop, peaq events (`docs/handoffs/peaq-machine-economy.md`) |
| `agents/scripts/machines/` | #228 | unassigned | One-time setup: activate the two simulated machines on peaq, create the fleet mission + robot mandate |
| `agents/src/index.ts` | first PR | whoever lands first | Re-exports; later PRs add one line each |

The first `agents` claim PR to merge adds `agents/package.json`, `tsconfig.json` and `src/index.ts`. Its `test` script
runs `tsc --noEmit`, then `node --import tsx --test "test/**/*.test.ts"` with the glob **quoted**, so Node expands it
at any depth instead of `sh`. All tests live in-lane in `agents/test/` (the injection corpus in `agents/test/injection/`),
like chain, surface and mcp: tests import third-party packages, which only resolve from inside the lane. The other agent
rebases onto that first PR.

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

// machines/ (#227): simulated machines, real devnet deals and real peaq events. Uses only instructions already on
// CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV; adds none.
type MeterReading = { padId: string; robotId: string; kWh: string; startedAt: number; endedAt: number; priceMicroUsdc: bigint; nonce: string };
signReading(r: MeterReading, padSecret: Uint8Array): { reading: MeterReading; signature: Uint8Array; deliveryHash: Uint8Array }; // sha256(canonical JSON)
verifyReading(r: MeterReading, signature: Uint8Array, padPublic: Uint8Array): boolean;
type PeaqConfig = { rpcUrl: string; deployment: string; eventRegistry: string; sourceChainId: 0 | 3338 | 8453 }; // never hard-coded (#226)
// peaq accepts only these source chains, not Solana. sourceChainId 0 => trustLevel 0 (self-reported): the event carries
// the full Solana release signature in rawData (sourceTxHash = its sha256) and never claims peaq verified the payment.
// trustLevel 1 only on a source chain peaq can verify (3338, 8453). Decided in #226 (agung, 1.0 machines).
interface PeaqClient {
  submitRevenueEvent(machineId: bigint, s: Settlement): Promise<Ok<{ txHash: string }> | Refused>; // value USD cents, currency "USD", trustLevel per sourceChainId
  submitActivityEvent(machineId: bigint, s: Settlement): Promise<Ok<{ txHash: string }> | Refused>; // value 0, currency "", trustLevel per sourceChainId
  queryMcr(machineId: bigint): Promise<Ok<{ status: string; score?: number }> | Refused>;          // "not served" is a refusal, not a guess
}
type Settlement = { chargeId: string; deal: Address; releaseSignature: string; deliveryHash: Uint8Array; amount: bigint }; // rawData = canonical JSON of this + cluster/program
charge(deps: ChargeDeps, req: { chargeId: string; amount: bigint; reading: MeterReading }): Promise<Ok<{
  openSig: string; deliverSig: string; releaseSig: string; padEventTx: string; robotEventTx: string }> | Refused>;
// Simulates before every send: an over-limit amount returns the program's code (OverPerTxCap, OverMandateCap,
// PayeeNotAllowed) as a refusal and signs nothing. Idempotent per chargeId: never releases twice, never writes a peaq
// event twice for one release (a retry resumes where the last run stopped).
```

## Rules

- Untrusted text (listings, endpoint replies, web pages, other agents' output) only ever enters through a `Reader`.
- No module returns or logs a sealed credential or a private key; tests assert it.
- Amounts are bigint base units; all arithmetic in code, never by a model.
- Network calls only through the broker's egress (`egressAllowed`); tests use local stubs.
- machines/: peaq RPC calls go through the injected `PeaqClient` (the egress rule above is for agents running inside a
  mission; this is server-side settlement code). Machines are simulated and labelled so wherever named. Keys
  (`MACHINE_OWNER_KEY` for the setup scripts only, `ROBOT_AGENT_KEY`, `PAD_KEY`, `PEAQ_EVENT_KEY`) are devnet/testnet
  only, from env or local files. Import path for other lanes: `@deal/agents/machines`. The fleet mission must be
  created with `rentLamports` (it pays rent for the deals its agent opens), and the pad needs a token account.
- Verify: `npm test --prefix agents`. Network or Docker tests are opt-in by env var (`AGENTS_NET=1`, `AGENTS_DOCKER=1`),
  like `DEAL_CHECK_DEVNET` in chain.
