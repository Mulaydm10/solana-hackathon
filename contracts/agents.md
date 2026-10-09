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
| `agents/src/machines/autonomy.ts` | #252 | unassigned | Simulated battery + the robot's own charge decision, capped by its mandate |
| `agents/src/machines/decide-llm.ts` | #254 | unassigned | Optional: Claude makes the charge decision (Physical AI), same caps, labelled fallback |
| `agents/scripts/serve-missions.ts` ticker | #257 | unassigned | The always-on service ticks the robot (POST /api/machines/tick) |
| `agents/src/machines/score.ts` | #267 | unassigned | peaq v2: read a machine's events from EventRegistry logs; open MCR-style score |
| `agents/src/machines/heartbeat.ts` | #268 | unassigned | peaq v2: peaq-format signed heartbeats, uptime, outage proof |
| `agents/src/machines/network.ts` | #269 | unassigned | peaq v2: several pads; the robot picks one (rule, or Claude among eligible pads) |
| `agents/src/machines/jobs.ts` | #270 | unassigned | peaq v2: a simulated shop pays the robot per delivery on escrow; robot revenue event |
| `agents/src/machines/insurance.ts` | #271 | unassigned | peaq v2: parametric downtime insurance on the existing escrow (no program change) |
| `agents/scripts/machines/network-setup.ts` | #272 | unassigned | peaq v2: pads 2-3, insurer, verifier, shop, mission paying all pads |
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

// machines/autonomy.ts (#252): the robot decides for itself. Battery and driving are SIMULATED and labelled so; the
// payment it decides on is real. Pure and deterministic.
type RobotModel = { capacityKwh: number; drainPctPerHour: number; lowPct: number; targetPct: number; pricePerKwhMicro: bigint };
const DEFAULT_ROBOT: RobotModel; // e.g. 2 kWh, low 25 %, target 80 %, the pad's price (web lib/machines.ts pricePerKwh)
type Battery = { levelPct: number; updatedAt: number };                   // unix seconds
advance(b: Battery, nowSecs: number, m: RobotModel): Battery;              // drains since updatedAt, never below 0
type MandateLeft = { perTxCap: bigint; cap: bigint; spent: bigint; live: boolean };
type Decision =
  | { action: "wait"; reason: string }
  | { action: "charge"; kWh: string; amount: bigint; reason: string };     // kWh 3 decimals; amount = kWh × price, rounded down to whole cents
decide(b: Battery, mandate: MandateLeft, m: RobotModel): Decision;
// charge only when level < lowPct and the mandate is live; kWh to reach targetPct, then amount capped (in code) at
// perTxCap and at cap − spent (kWh recomputed from the capped amount); amount < 0.01 USDC => wait. Never throws.
afterCharge(b: Battery, kWh: string, nowSecs: number, m: RobotModel): Battery;

// machines/decide-llm.ts (#254, optional): the same Decision from a model, never trusted with amounts.
type Telemetry = { battery: Battery; distanceToPadKm: number; nextDeliveryKm: number; pricePerKwhMicro: bigint }; // simulated
decideWithModel(llm: (system: string, prompt: string) => Promise<string>, t: Telemetry, mandate: MandateLeft, m: RobotModel):
  Promise<Decision & { by: "claude" | "simulated" }>;
// telemetry goes in as quarantined data; output must parse as {action, kWh, reason} (strict); amounts are recomputed and
// capped exactly as decide() does; any failure or no model => decide() with by "simulated". Never throws.

// scripts/serve-missions.ts ticker (#257): machineTicker({ url, secret, intervalMs, fetch, now, log }) POSTs the tick URL
// with "Authorization: Bearer <secret>" every intervalMs (default 30 min), one at a time; env MACHINE_TICK_URL,
// MACHINE_TICK_SECRET (>= 32 chars), MACHINE_TICK_MS. Logs status + decision only, never the secret.
```

## peaq v2 (#267-#272; plan: docs/handoffs/peaq-v2-plan.md)

All new files under `agents/src/machines/`, each re-exported by one line in `machines/index.ts`. Pure functions take
`nowSecs` (unix seconds) and never read the clock; I/O goes through injected interfaces; tests stub them. Money is bigint
micro-USDC in whole cents. Results `Ok | Refused`, never throws for expected refusals.

```ts
// score.ts (#267) ------------------------------------------------------------------------------------------------
// One event as read from the EventRegistry log. agung v1 log: address = registry, topics = [sig, machineId, index],
// data = abi(uint8 eventType, uint256 value); the timestamp is the block's. value = USD cents for revenue (type 0).
// Convention (ours, documented in rawData kind "fiducia-outage-v1"): an activity event (type 1) with value > 0 is an
// OUTAGE (value = outage seconds) and counts as a negative event.
type MachineEvent = { machineId: bigint; index: bigint; eventType: 0 | 1; value: bigint; timestamp: number; txHash: string; block: bigint };
type LogIo = { getLogs(q: { address: string; topics: (string | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
               blockNumber(): Promise<bigint>; blockTimestamp(block: bigint): Promise<number> };
type RawLog = { topics: string[]; data: string; transactionHash: string; blockNumber: bigint };
readMachineEvents(io: LogIo, registry: string, machineId: bigint, fromBlock: bigint, o?: { chunk?: bigint }):
  Promise<Ok<{ events: MachineEvent[]; toBlock: bigint }> | Refused>;   // chunked getLogs (default 10_000 blocks), sorted by index
type Grade = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "NR" | "Provisioned";
type ScoreFactors = { bond: number; revenue: number; activity: number; tenure: number; freshness: number; penalty: number };
type MachineScore = { score: number; grade: Grade; provisioned: boolean; factors: ScoreFactors; events: number; outages7d: number; explain: string };
scoreMachine(events: MachineEvent[], o: { bonded: boolean; nowSecs: number }): MachineScore;
// Exact formula (integers after rounding the sum):
//   not bonded -> score 0, grade NR.  Provisioned (score 0) if events < 10 or (last - first event) < 3 days.
//   bond 20 | revenue 30 x (UTC days of the last 14 with revenue >= 10 cents) / 14 | activity 20 x min(1, events in last 14 days / 28)
//   tenure 10 x min(1, span days / 14) | freshness 20 if last event <= 24 h old, linear to 0 at 7 days
//   penalty -15 per outage in the last 7 days. score = clamp(round(sum), 0, 100).
//   grade: >=95 AAA, >=85 AA, >=75 A, >=60 BBB, >=45 BB, >=30 B, else NR (peaq's documented scale).
// explain: one plain sentence naming the two largest factors and any penalty.

// heartbeat.ts (#268) --------------------------------------------------------------------------------------------
type Heartbeat = { machineId: string; sentAt: number; signature: `0x${string}`; address: `0x${string}` };  // pad's peaq EVM address
heartbeatMessage(machineId: string, sentAt: number): string;           // exactly `machineId: ${id}\nsentAt: ${sentAt}` (peaq format)
signHeartbeat(machineId: string, sentAt: number, peaqPrivateKey: `0x${string}`): Promise<Heartbeat>;   // EIP-191 (viem)
verifyHeartbeat(h: Heartbeat, expectedAddress: `0x${string}`): Promise<boolean>;                    // never throws
type Gap = { from: number; to: number; secs: number };
uptime(beats: Heartbeat[], o: { from: number; to: number; outageAfterSecs: number }): { upPct: number; gaps: Gap[]; lastBeatAt: number | null };
//   only verified beats are passed in; a gap = consecutive beats (or from/last beat to `to`) more than outageAfterSecs apart.
type OutageProof = { kind: "fiducia-outage-v1"; machineId: string; policy: string; lastBeat: Heartbeat; detectedAt: number; gapSecs: number };
outageProof(machineId: string, policy: string, lastBeat: Heartbeat, detectedAt: number): OutageProof;
canonicalOutage(p: OutageProof): Uint8Array;  outageHash(p: OutageProof): Uint8Array;  // sha256, fixed key order
verifyOutageProof(p: OutageProof, padAddress: `0x${string}`, o: { outageAfterSecs: number; nowSecs: number }): Promise<boolean>;
//   lastBeat verifies, gapSecs = detectedAt - lastBeat.sentAt > outageAfterSecs, detectedAt <= nowSecs.
OUTAGE_AFTER_SECS = 3900;   // two missed 30-min ticks + 5 min grace

// network.ts (#269) ----------------------------------------------------------------------------------------------
type PadOffer = { role: string; machineId: bigint; address: Address; pricePerKwhMicro: bigint; online: boolean; score: number; grade: Grade };
type PadChoice = { ok: true; pad: PadOffer; effectivePriceMicro: bigint; reason: string; by: "robot" | "claude" | "simulated" }
               | { ok: false; reason: string };   // nobody eligible
choosePad(offers: PadOffer[], o: { allowedPayees: Address[] }): PadChoice;
//   eligible = online && address in allowedPayees. effective = price x (1 + (100 - score) / 200), Provisioned -> x 1.25,
//   NR -> x 1.5 (integer micro, rounded up). Lowest effective wins; tie -> lower machineId. reason names price, grade, uptime.
choosePadWithModel(llm: LlmFn, offers: PadOffer[], o: { allowedPayees: Address[] }): Promise<PadChoice>;
//   offers go in as quarantined data; the model returns strict {role, reason}; a role not eligible or any failure ->
//   choosePad() with by "simulated". The reason shown is code-first, model text quoted, like decide-llm.ts.
// setup.ts: robotMandate/fleetRules accept `pads: Address[]` (payee list); the old single `pad` stays accepted.

// jobs.ts (#270) -------------------------------------------------------------------------------------------------
type DropOff = { jobId: string; robotId: string; at: number; km: number };   // simulated, signed by the robot's Solana key
signDropOff(d: DropOff, robotSecret: Uint8Array): { dropOff: DropOff; signature: Uint8Array; deliveryHash: Uint8Array };
interface JobChain {                       // shop = buyer (its own policy, create_deal), robot = seller
  openDeal(jobId: string, amount: bigint, termsHash: Uint8Array): Promise<Sent<{ deal: Address }>>;  // shop
  accept(deal: Address): Promise<Sent>;                                                          // robot
  deliver(deal: Address, deliveryHash: Uint8Array, invoice: bigint): Promise<Sent>;             // robot
  release(deal: Address, deliveryHash: Uint8Array): Promise<Sent>;                               // shop
}
runJob(deps: { chain: JobChain; peaq: PeaqClient; ledger: ChargeLedger; robotSecret: Uint8Array; robotMachineId: bigint },
       req: { jobId: string; amount: bigint; km: number; nowSecs: number }): Promise<Ok<{ deal: Address; releaseSig: string; robotEventTx: string }> | Refused>;
//   resumes from the ledger like charge(); the robot gets a peaq REVENUE event (USD cents) linked to the release.
planJob(b: Battery, lastJobAt: number | null, o: { nowSecs: number; minPct: number; everySecs: number; drainPct: number }):
  { take: true; km: number } | { take: false; reason: string };     // defaults: minPct 35, everySecs 4 h, drainPct 15
chainJobChain(ctx, shop, robot): JobChain;   // over @deal/chain deals (create_deal / accept / submit_delivery / release)

// insurance.ts (#271) --------------------------------------------------------------------------------------------
PREMIUM_RATE_BPS: Record<Grade, number> = { AAA: 200, AA: 300, A: 400, BBB: 600, BB: 900, B: 1200, NR: 2000, Provisioned: 2000 };
quotePremium(coverage: bigint, grade: Grade, termSecs: number): Ok<{ premium: bigint; rateBps: number }> | Refused;
//   per 24 h of term, rounded UP to a whole cent, minimum 0.01 USDC.
type Policy = { id: string; pad: string; coverage: bigint; premium: bigint; grade: Grade; termStart: number; termEnd: number;
  status: "quoted" | "active" | "claimed" | "paid" | "expired" | "challenged"; deal?: Address; openSig?: string;
  acceptSig?: string; premiumSig?: string; claimSig?: string; payoutSig?: string; refundSig?: string;
  outage?: { proofHash: string; detectedAt: number; gapSecs: number; peaqEventTx?: string } };
interface InsuranceChain {
  openPolicy(policyId: string, coverage: bigint, termEnd: number, termsHash: Uint8Array): Promise<Sent<{ deal: Address }>>; // insurer: create_deal, seller = pad, verifier set
  accept(deal: Address): Promise<Sent>;                      // pad
  payPremium(amount: bigint, policyId: string): Promise<Sent>; // pad -> insurer SPL transfer (memo = policy id)
  fileClaim(deal: Address, proofHash: Uint8Array, coverage: bigint): Promise<Sent>;  // pad: submit_delivery
  challenge(deal: Address): Promise<Sent>;                   // insurer, only for an invalid proof
  claim(deal: Address): Promise<Sent>;                       // anyone, after the review window
  refund(deal: Address): Promise<Sent>;                      // anyone, after termEnd with no claim
}
insuranceStep(deps: { chain: InsuranceChain; peaq: PeaqClient; padMachineId: bigint; padAddress: `0x${string}` },
              p: Policy, o: { nowSecs: number; lastBeat: Heartbeat | null; reviewSecs: number }): Promise<Policy>;
//   one idempotent step: quoted -> open+accept+premium -> active; active + outage -> fileClaim + outage peaq event
//   (activity, value = gap seconds) -> claimed; claimed + window passed -> claim -> paid; active past termEnd -> refund
//   -> expired. Every signature is kept; a failed step leaves the policy as it was with the reason. Never throws.
// peaq.ts: PeaqClient gains submitOutageEvent(machineId, o: { gapSecs, proofHash, policy }) (activity event, value = gapSecs).
// Defaults: coverage 1.00 USDC, term 24 h, review window 600 s.

// scripts/machines/network-setup.ts (#272): idempotent; creates/reuses keys pad2, pad3, insurer, verifier, shop
// (+ peaq keys for pads); activates pad2/pad3 on agung like activate.ts; the shop's policy; a NEW fleet mission whose
// robot mandate pays [pad, pad2, pad3]; token accounts; writes state.json `network` (roles, machine ids, prices). Prints
// addresses and signatures only; never funds (says what is missing); --dry-run.
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
