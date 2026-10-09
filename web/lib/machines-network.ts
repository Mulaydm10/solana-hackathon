// Machines v2 (#273, peaq v2): the network of charging pads, their heartbeats, downtime insurance, the robot's delivery
// jobs and the pad choice. Pure logic over injected dependencies (chain, peaq, log reading, storage), so it is tested
// without a network; the real wiring is in machines-network-server.ts. Everything the page labels "simulated"
// (power switch, outages, deliveries, battery) is simulated; signatures, payments and peaq events are real.
// Each tick step records its own failure and never stops the next one.
import type { Address } from "@solana/kit";
import {
  advance, choosePad, choosePadWithModel, DEFAULT_ROBOT, insuranceStep, JOB_DEFAULTS, parseKwhMilli, planJob, priceCharge,
  quotePremium, readMachineEvents, runJob, scoreMachine, verifyHeartbeat,
  type Grade, type Heartbeat, type MandateLeft, type InsuranceDeps, type JobDeps, type LlmFn, type MachineEvent, type MachineScore, type PadOffer, type Policy,
} from "@deal/agents/machines";
import { b58name, SLOT_SECS, type BatteryStore, type PadRoute } from "./machines";
import type { Blobs } from "./storage";

const DAY = 86_400;

// ---------- configuration (server env; keys are checked, never echoed) ----------

export const NETWORK_ROLES = ["pad", "pad2", "pad3"] as const;
export const PAD_NAMES: Record<string, string> = { pad: "Charging pad A", pad2: "Charging pad B", pad3: "Charging pad C" };

export type PadCfg = { role: string; name: string; machineId: bigint; address: Address; peaqAddress: `0x${string}`; pricePerKwhMicro: bigint };
export type NetworkConfig = { pads: PadCfg[]; insurer: Address; verifier: Address; shop: Address; mission: Address };
/** Secret key material, only ever handed to signers. */
export type NetworkKeys = { solana: Record<string, Uint8Array>; peaq: Record<string, `0x${string}`>; insurer: Uint8Array; shop: Uint8Array };
export type NotConfigured = { part: string; vars: string[] }[];

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

function keyBytes(s: string | undefined): Uint8Array | null {
  try {
    const a = JSON.parse(s ?? "") as unknown;
    return Array.isArray(a) && a.length === 64 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Uint8Array.from(a as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * The v2 variables (contract-web "Machines v2"). Any missing or malformed part means v1 behaviour continues; the
 * result names the parts and variables (never a value) so the status can say what is not configured.
 */
export function parseNetworkEnv(raw: Record<string, string | undefined>): { ok: true; cfg: NetworkConfig; keys: NetworkKeys } | { ok: false; missing: NotConfigured } {
  const missing: NotConfigured = [];
  const need = (part: string, vars: string[]) => { if (vars.length) missing.push({ part, vars }); };
  const bad = (names: string[]) => names.filter((n) => keyBytes(raw[n]) === null);
  need("pads", bad(["PAD2_KEY", "PAD3_KEY"]));
  need("insurance", [...bad(["INSURER_KEY"]), ...(B58.test(raw.INSURANCE_VERIFIER ?? "") ? [] : ["INSURANCE_VERIFIER"])]);
  need("shop", bad(["SHOP_KEY"]));

  let peaqKeys: Record<string, string> | null = null;
  try {
    const j = JSON.parse(raw.PAD_PEAQ_KEYS ?? "") as Record<string, unknown>;
    if (NETWORK_ROLES.every((r) => typeof j[r] === "string" && HEX_KEY.test(j[r] as string))) peaqKeys = j as Record<string, string>;
  } catch { /* reported below */ }
  if (!peaqKeys) need("heartbeats", ["PAD_PEAQ_KEYS"]);

  type NetJson = { pads?: unknown; insurer?: unknown; verifier?: unknown; shop?: unknown; mission?: unknown };
  const net: NetJson | null = (() => { try { const j = JSON.parse(raw.MACHINE_NETWORK ?? "") as unknown; return j && typeof j === "object" ? (j as NetJson) : null; } catch { return null; } })();
  const pads: PadCfg[] = [];
  if (net && Array.isArray(net.pads)) {
    for (const role of NETWORK_ROLES) {
      const p = (net.pads as Record<string, unknown>[]).find((x) => x?.role === role);
      try {
        if (!p || typeof p.address !== "string" || !B58.test(p.address) || typeof p.peaqAddress !== "string" || !HEX_ADDR.test(p.peaqAddress)) throw new Error("pad");
        pads.push({
          role, name: PAD_NAMES[role]!, machineId: BigInt(String(p.machineId)), address: p.address as Address, peaqAddress: p.peaqAddress as `0x${string}`,
          pricePerKwhMicro: BigInt(String(p.pricePerKwhMicro)),
        });
      } catch { break; }
    }
  }
  const netOk = net !== null && pads.length === NETWORK_ROLES.length && [net.insurer, net.verifier, net.shop, net.mission].every((a) => typeof a === "string" && B58.test(a));
  if (!netOk) need("network", ["MACHINE_NETWORK"]);
  const solana: Record<string, Uint8Array> = {};
  const pad = keyBytes(raw.PAD_KEY), pad2 = keyBytes(raw.PAD2_KEY), pad3 = keyBytes(raw.PAD3_KEY);
  if (!pad) need("pads", ["PAD_KEY"]);
  const insurer = keyBytes(raw.INSURER_KEY), shop = keyBytes(raw.SHOP_KEY);
  if (missing.length > 0 || !netOk || !peaqKeys || !pad || !pad2 || !pad3 || !insurer || !shop) return { ok: false, missing };
  solana.pad = pad; solana.pad2 = pad2; solana.pad3 = pad3;
  const n = net as unknown as { insurer: string; verifier: string; shop: string; mission: string };
  return {
    ok: true,
    cfg: { pads, insurer: n.insurer as Address, verifier: n.verifier as Address, shop: n.shop as Address, mission: n.mission as Address },
    keys: { solana, peaq: peaqKeys as Record<string, `0x${string}`>, insurer, shop },
  };
}

// ---------- storage ----------

export type StoredPolicy = Omit<Policy, "coverage" | "premium"> & { coverage: string; premium: string };
export type JobRecord = { id: string; at: number; amount: string; deal?: string; releaseSig?: string; robotEventTx?: string };
export type JobState = { lastJobAt: number | null; pending?: { id: string; at: number; km: number; amount: string }; done: JobRecord[] };
type StoredEvent = { machineId: string; index: string; eventType: 0 | 1; value: string; timestamp: number; txHash: string; block: string };
/** Scores recomputed from the peaq logs at most once per tick, with the events read so far (so the next tick reads only new blocks). */
export type ScoreCache = { computedAt: number; toBlock: Record<string, string>; events: Record<string, StoredEvent[]>; scores: Record<string, MachineScore> };
export type StepResult = { step: "scores" | "heartbeats" | "insurance" | "job"; ok: boolean; detail?: string };
export type TickReport = { at: number; steps: StepResult[] };

export interface NetworkStore {
  beats(): Promise<Record<string, Heartbeat[]>>;
  addBeat(role: string, h: Heartbeat): Promise<void>;
  power(): Promise<Record<string, boolean>>;
  setPower(role: string, online: boolean): Promise<void>;
  policies(): Promise<StoredPolicy[]>;
  putPolicy(p: StoredPolicy): Promise<void>;
  jobs(): Promise<JobState>;
  putJobs(s: JobState): Promise<void>;
  scores(): Promise<ScoreCache | null>;
  putScores(c: ScoreCache): Promise<void>;
  lastTick(): Promise<TickReport | null>;
  putLastTick(t: TickReport): Promise<void>;
}

export const BEATS_KEPT = 120; // 48 a day at one per 30-minute slot
export const POLICIES_KEPT = 30;
export const JOBS_KEPT = 30;

export function blobNetworkStore(blobs: Blobs): NetworkStore {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const doc = <T>(key: string, empty: () => T) => {
    const name = b58name("network", key);
    return {
      get: async (): Promise<T> => { const b = await blobs.read(name); return b ? (JSON.parse(new TextDecoder().decode(b)) as T) : empty(); },
      put: (v: T) => blobs.write(name, enc(v)),
    };
  };
  const beats = doc<Record<string, Heartbeat[]>>("machines-network-beats-v1", () => ({}));
  const power = doc<Record<string, boolean>>("machines-network-power-v1", () => ({}));
  const policies = doc<StoredPolicy[]>("machines-network-policies-v1", () => []);
  const jobs = doc<JobState>("machines-network-jobs-v1", () => ({ lastJobAt: null, done: [] }));
  const scores = doc<ScoreCache | null>("machines-network-scores-v1", () => null);
  const tick = doc<TickReport | null>("machines-network-tick-v1", () => null);
  return {
    beats: beats.get,
    addBeat: async (role, h) => { const all = await beats.get(); await beats.put({ ...all, [role]: [...(all[role] ?? []), h].slice(-BEATS_KEPT) }); },
    power: power.get,
    setPower: async (role, online) => power.put({ ...(await power.get()), [role]: online }),
    policies: policies.get,
    putPolicy: async (p) => policies.put([...(await policies.get()).filter((x) => x.id !== p.id), p].slice(-POLICIES_KEPT)),
    jobs: jobs.get,
    putJobs: (s) => jobs.put({ ...s, done: s.done.slice(0, JOBS_KEPT) }),
    scores: scores.get,
    putScores: scores.put,
    lastTick: tick.get,
    putLastTick: tick.put,
  };
}

export const toStoredPolicy = (p: Policy): StoredPolicy => ({ ...p, coverage: p.coverage.toString(), premium: p.premium.toString() });
export const fromStoredPolicy = (p: StoredPolicy): Policy => ({ ...p, coverage: BigInt(p.coverage), premium: BigInt(p.premium) });

// ---------- the tick ----------

export const INSURANCE = { coverage: 1_000_000n, termSecs: DAY, reviewSecs: 60 } as const;
/** What the simulated shop pays per simulated km of a delivery: whole cents (peaq revenue events refuse a fraction of a cent). */
export const JOB_RATE_PER_KM = 100_000n;
/** About 14 days of blocks on agung at any block time above ~5 s; later ticks read only the blocks since the last read. */
const LOOKBACK_BLOCKS = 250_000n;
const KEEP_EVENTS_SECS = 30 * DAY;

export type NetworkDeps = {
  cfg: NetworkConfig;
  robotMachineId: bigint;
  store: NetworkStore;
  battery: BatteryStore;
  /** The pad's signed peaq heartbeat (EIP-191 with its peaq key). */
  signBeat(pad: PadCfg, sentAt: number): Promise<Heartbeat>;
  insuranceDeps(pad: PadCfg): InsuranceDeps;
  job: JobDeps;
  headBlock(): Promise<bigint>;
  readEvents(machineId: bigint, fromBlock: bigint): ReturnType<typeof readMachineEvents>;
  /** Set only when ANTHROPIC_API_KEY is: Claude chooses among the eligible pads. */
  llm?: LlmFn;
  /** The robot mandate's payee list, read from chain. */
  allowedPayees(): Promise<Address[]>;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120);
const slotOf = (t: number) => Math.floor(t / SLOT_SECS);

const toStoredEvent = (e: MachineEvent): StoredEvent => ({ machineId: e.machineId.toString(), index: e.index.toString(), eventType: e.eventType, value: e.value.toString(), timestamp: e.timestamp, txHash: e.txHash, block: e.block.toString() });
const fromStoredEvent = (e: StoredEvent): MachineEvent => ({ machineId: BigInt(e.machineId), index: BigInt(e.index), eventType: e.eventType, value: BigInt(e.value), timestamp: e.timestamp, txHash: e.txHash, block: BigInt(e.block) });

/** Heartbeats whose signature verifies against the pad's peaq address and that name this machine. Verified on every read. */
export async function verifiedBeats(store: NetworkStore, pad: PadCfg): Promise<Heartbeat[]> {
  const all = (await store.beats())[pad.role] ?? [];
  const ok: Heartbeat[] = [];
  for (const h of all) if (h.machineId === pad.machineId.toString() && (await verifyHeartbeat(h, pad.peaqAddress))) ok.push(h);
  return ok;
}

/** Recomputes every machine's score from its peaq logs: once per tick, cached in the blob store. */
async function refreshScores(d: NetworkDeps, now: number): Promise<StepResult> {
  const prev = await d.store.scores();
  const head = await d.headBlock();
  const machines: [string, bigint][] = [["robot", d.robotMachineId], ...d.cfg.pads.map((p): [string, bigint] => [p.role, p.machineId])];
  const events: Record<string, StoredEvent[]> = { ...(prev?.events ?? {}) };
  const toBlock: Record<string, string> = { ...(prev?.toBlock ?? {}) };
  const failures: string[] = [];
  await Promise.all(machines.map(async ([role, id]) => {
    const from = toBlock[role] !== undefined ? BigInt(toBlock[role]!) + 1n : head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const r = await d.readEvents(id, from).catch((e: unknown) => ({ ok: false as const, reason: "log-read-failed", message: errMsg(e) }));
    if (!r.ok) { failures.push(`${role}: ${r.reason}`); return; }
    const have = new Map((events[role] ?? []).map((e) => [e.index, e]));
    for (const e of r.events) have.set(e.index.toString(), toStoredEvent(e));
    events[role] = [...have.values()].filter((e) => e.timestamp >= now - KEEP_EVENTS_SECS);
    toBlock[role] = r.toBlock.toString();
  }));
  const scores: Record<string, MachineScore> = {};
  for (const [role] of machines) scores[role] = scoreMachine((events[role] ?? []).map(fromStoredEvent), { bonded: true, nowSecs: now });
  await d.store.putScores({ computedAt: now, toBlock, events, scores });
  return failures.length ? { step: "scores", ok: false, detail: failures.join("; ") } : { step: "scores", ok: true };
}

async function beatStep(d: NetworkDeps, now: number): Promise<StepResult> {
  const power = await d.store.power();
  const failures: string[] = [];
  for (const pad of d.cfg.pads) {
    if (power[pad.role] === false) continue; // offline pads sign nothing
    try {
      const last = ((await d.store.beats())[pad.role] ?? []).at(-1);
      if (last && slotOf(last.sentAt) === slotOf(now) && last.sentAt <= now) continue; // one beat per slot
      const h = await d.signBeat(pad, now);
      if (!(await verifyHeartbeat(h, pad.peaqAddress))) { failures.push(`${pad.role}: the signed heartbeat does not verify against the pad's address`); continue; }
      await d.store.addBeat(pad.role, h);
    } catch (e) {
      failures.push(`${pad.role}: ${errMsg(e)}`);
    }
  }
  return failures.length ? { step: "heartbeats", ok: false, detail: failures.join("; ") } : { step: "heartbeats", ok: true };
}

const LIVE = new Set(["quoted", "active", "claimed"]);

async function insuranceStepAll(d: NetworkDeps, now: number): Promise<StepResult> {
  const power = await d.store.power();
  const cache = await d.store.scores();
  const failures: string[] = [];
  for (const pad of d.cfg.pads) {
    try {
      const deps = d.insuranceDeps(pad);
      const lastBeat = (await verifiedBeats(d.store, pad)).at(-1) ?? null;
      const mine = () => d.store.policies().then((l) => l.filter((p) => p.pad === pad.address).sort((a, b) => b.termStart - a.termStart));
      let cur = (await mine()).find((p) => LIVE.has(p.status));
      // At most two steps per pad per tick: the current policy, then (if it just ended and the pad is up) a fresh quote.
      for (let i = 0; i < 2; i++) {
        if (cur && cur.status === "quoted" && !cur.deal && now >= cur.termEnd) {
          // never opened and already over: close it so a fresh policy can be quoted
          await d.store.putPolicy({ ...cur, status: "expired", reason: "the term ended before the policy could be opened" });
          cur = undefined;
        }
        if (!cur) {
          if (power[pad.role] === false) break; // no new policy on a pad that is switched off
          const grade: Grade = cache?.scores[pad.role]?.grade ?? "Provisioned";
          const q = quotePremium(INSURANCE.coverage, grade, INSURANCE.termSecs);
          if (!q.ok) { failures.push(`${pad.role}: ${q.reason}`); break; }
          const quoted: Policy = {
            id: `pol-${pad.role}-${now}`, pad: pad.address, coverage: INSURANCE.coverage, premium: q.premium, grade, termStart: now, termEnd: now + INSURANCE.termSecs, status: "quoted",
          };
          await d.store.putPolicy(toStoredPolicy(quoted));
          cur = toStoredPolicy(quoted);
        }
        const next = await insuranceStep(deps, fromStoredPolicy(cur), { nowSecs: now, lastBeat, reviewSecs: INSURANCE.reviewSecs });
        await d.store.putPolicy(toStoredPolicy(next));
        if (next.reason) { failures.push(`${pad.role}: ${next.reason}`); break; }
        if (LIVE.has(next.status)) break;
        cur = undefined;
      }
    } catch (e) {
      failures.push(`${pad.role}: ${errMsg(e)}`);
    }
  }
  return failures.length ? { step: "insurance", ok: false, detail: failures.join("; ") } : { step: "insurance", ok: true };
}

const jobPay = (km: number): bigint => BigInt(Math.max(1, Math.round(km))) * JOB_RATE_PER_KM;

async function jobStep(d: NetworkDeps, now: number): Promise<StepResult> {
  const st = await d.store.jobs();
  const stored = await d.battery.get();
  const b = advance(stored ?? { levelPct: 60, updatedAt: now }, now, DEFAULT_ROBOT);
  let pending = st.pending;
  if (!pending) {
    const plan = planJob(b, st.lastJobAt, { nowSecs: now });
    if (!plan.take) return { step: "job", ok: true, detail: plan.reason };
    pending = { id: `job-${now}`, at: now, km: plan.km, amount: jobPay(plan.km).toString() };
    await d.store.putJobs({ ...st, pending });
  }
  const r = await runJob(d.job, { jobId: pending.id, amount: BigInt(pending.amount), km: pending.km, nowSecs: pending.at });
  if (!r.ok) return { step: "job", ok: false, detail: `${pending.id}: ${r.reason}` }; // stays pending; the next tick resumes it from the ledger
  const rec: JobRecord = { id: pending.id, at: pending.at, amount: pending.amount, deal: r.deal, releaseSig: r.releaseSig, robotEventTx: r.robotEventTx };
  await d.store.putJobs({ lastJobAt: now, done: [rec, ...st.done] });
  // The trip drains the simulated battery; lastSlot is kept so the robot's once-per-slot decision still runs.
  await d.battery.put({ levelPct: Math.max(0, b.levelPct - JOB_DEFAULTS.drainPct), updatedAt: b.updatedAt, lastSlot: stored?.lastSlot ?? -1 });
  return { step: "job", ok: true, detail: `${pending.id} delivered (simulated)` };
}

/** Steps 1 to 3 of the tick, in order. A step that throws is recorded as failed; the next still runs. */
export async function networkPrelude(d: NetworkDeps, now: number): Promise<TickReport> {
  const run = async (step: StepResult["step"], fn: () => Promise<StepResult>): Promise<StepResult> => {
    try { return await fn(); } catch (e) { return { step, ok: false, detail: errMsg(e) }; }
  };
  const steps: StepResult[] = [];
  steps.push(await run("scores", () => refreshScores(d, now)));
  steps.push(await run("heartbeats", () => beatStep(d, now)));
  steps.push(await run("insurance", () => insuranceStepAll(d, now)));
  steps.push(await run("job", () => jobStep(d, now)));
  const report = { at: now, steps };
  await d.store.putLastTick(report).catch(() => undefined);
  return report;
}

/** Step 4: the robot's decided charge goes to the pad it chooses; the amount is re-priced at that pad, in code, from the decided kWh. */
export async function routeCharge(d: NetworkDeps, dec: { kWh: string; amount: bigint }, mandate: MandateLeft): Promise<PadRoute> {
  const cache = await d.store.scores();
  const power = await d.store.power();
  const offers: PadOffer[] = d.cfg.pads.map((p) => ({
    role: p.role, machineId: p.machineId, address: p.address, pricePerKwhMicro: p.pricePerKwhMicro, online: power[p.role] !== false,
    score: cache?.scores[p.role]?.score ?? 0, grade: cache?.scores[p.role]?.grade ?? "Provisioned",
  }));
  const allowedPayees = await d.allowedPayees();
  const choice = d.llm ? await choosePadWithModel(d.llm, offers, { allowedPayees }) : choosePad(offers, { allowedPayees });
  if (!choice.ok) return { ok: false, reason: choice.reason };
  const want = parseKwhMilli(dec.kWh) ?? 0n;
  const p = priceCharge(want, mandate, { ...DEFAULT_ROBOT, pricePerKwhMicro: choice.pad.pricePerKwhMicro });
  if (!p.ok) return { ok: false, reason: `${choice.pad.role}: the mandate left allows nothing to charge at its price` };
  return { ok: true, padRole: choice.pad.role, amount: p.amount, kWh: p.kWh, reason: choice.reason, by: choice.by };
}

// ---------- the owner's simulated power switch ----------

export async function setPadPower(store: NetworkStore, cfg: NetworkConfig, body: unknown): Promise<{ ok: true; pad: string; online: boolean } | { ok: false; status: number; reason: string; message: string }> {
  const b = (body ?? {}) as { pad?: unknown; online?: unknown };
  if (typeof b.pad !== "string" || !cfg.pads.some((p) => p.role === b.pad)) return { ok: false, status: 400, reason: "BAD_PAD", message: `pad must be one of ${cfg.pads.map((p) => p.role).join(", ")}` };
  if (typeof b.online !== "boolean") return { ok: false, status: 400, reason: "BAD_ONLINE", message: "online must be true or false" };
  await store.setPower(b.pad, b.online);
  return { ok: true, pad: b.pad, online: b.online };
}

// ---------- reading the chain's logs (peaq EVM JSON-RPC) ----------

/** A LogIo over plain JSON-RPC: eth_blockNumber, eth_getLogs, eth_getBlockByNumber. `fetchFn` is injectable. */
export function jsonRpcLogIo(rpcUrl: string, fetchFn: typeof fetch = fetch) {
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetchFn(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) throw new Error(`peaq rpc answered HTTP ${res.status}`);
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`peaq rpc: ${String(j.error.message ?? "error").slice(0, 80)}`);
    return j.result;
  };
  const hex = (n: bigint) => "0x" + n.toString(16);
  return {
    blockNumber: async () => BigInt(String(await call("eth_blockNumber", []))),
    getLogs: async (q: { address: string; topics: (string | null)[]; fromBlock: bigint; toBlock: bigint }) => {
      const logs = (await call("eth_getLogs", [{ address: q.address, topics: q.topics, fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock) }])) as { topics: string[]; data: string; transactionHash: string; blockNumber: string }[];
      return logs.map((l) => ({ topics: l.topics, data: l.data, transactionHash: l.transactionHash, blockNumber: BigInt(l.blockNumber) }));
    },
    blockTimestamp: async (block: bigint) => {
      const b = (await call("eth_getBlockByNumber", [hex(block), false])) as { timestamp: string } | null;
      if (!b) throw new Error("block not found");
      return Number(BigInt(b.timestamp));
    },
  };
}
