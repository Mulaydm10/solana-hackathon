// /machines (#229, peaq track): a simulated delivery robot pays a simulated charging pad on devnet, settled on the
// pad's signed meter reading, with peaq events for both machines. This module is the testable logic; the chain,
// peaq and storage wiring is in machines-server.ts. Every transaction is simulated first and sent only if the
// simulation passes, so the over-limit button is refused by the program and nothing is sent.
import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import type { DealClient } from "@deal/chain";
import { advance, afterCharge, decide, DEFAULT_ROBOT, decideWithModel, type Battery, type ChargeLedger, type ChargeRecord, type MandateLeft, type MeterReading, type Telemetry } from "@deal/agents/machines";
import type { Blobs } from "./storage";

type Refusal = { ok: false; reason: string; message: string };
const no = (status: number, reason: string, message: string) => ({ ok: false as const, status, reason, message });

const USDC = 1_000_000n;
export const MACHINE_LIMITS = {
  /** The only amounts the API accepts. 0.60 is over the robot's 0.50 per-charge limit: it shows the refusal. */
  amounts: { "0.40": 400_000n, "0.60": 600_000n } as Record<string, bigint>,
  /** The pad's simulated price per kWh, to turn an amount into a meter reading. */
  pricePerKwh: 320_000n,
  chargesPerIpPerHour: 6,
  chargesPerDay: 60,
  history: 30,
} as const;

/** One charge as the page shows it. Amounts are decimal USDC strings; refusals are normal results. */
export type ChargeView = {
  id: string;
  at: number;
  amount: string;
  kWh: string;
  deal?: string;
  deliveryHash?: string;
  openSig?: string;
  deliverSig?: string;
  releaseSig?: string;
  padEventTx?: string;
  robotEventTx?: string;
  refused?: { reason: string; message: string };
  /** Who started the charge: a visitor's button, the robot on its own (#253), or Claude (#255). Older records have neither. */
  by?: "visitor" | "robot" | "claude" | "simulated";
};

export type ChargeOutcome = ({ ok: true } & Record<string, unknown>) | Refusal;

export type MachineDeps = {
  limit: (key: string, max: number, windowMs: number) => boolean;
  nowSecs: () => number;
  newChargeId: () => string;
  padId: string;
  robotId: string;
  /** Runs one charge (agents `charge()` through the simulate-first chain). */
  charge: (req: { chargeId: string; amount: bigint; reading: MeterReading }) => Promise<ChargeOutcome>;
  ledger: ChargeLedger;
  history: ChargeHistory;
};

export const usdc = (base: bigint) => `${base / USDC}.${(base % USDC).toString().padStart(6, "0").slice(0, 2)}`;

/** The meter reading for an amount at the pad's price: kWh with 3 decimals, rounded down. */
export function meterKwh(amount: bigint): string {
  const milli = (amount * 1000n) / MACHINE_LIMITS.pricePerKwh;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, "0")}`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** POST /api/machines/charge: one charge, or the program's refusal. Never signs above the fixed amounts. */
export async function runMachineCharge(d: MachineDeps, ip: string, body: unknown): Promise<{ ok: true; charge: ChargeView } | ReturnType<typeof no>> {
  const key = typeof (body as { amount?: unknown })?.amount === "string" ? (body as { amount: string }).amount : "";
  const amount = MACHINE_LIMITS.amounts[key];
  if (amount === undefined) return no(400, "BAD_AMOUNT", `amount must be one of ${Object.keys(MACHINE_LIMITS.amounts).join(", ")}`);
  if (!d.limit(`charge:${ip}`, MACHINE_LIMITS.chargesPerIpPerHour, HOUR)) return no(429, "RATE_LIMITED", "too many charges from you; try again in an hour");
  if (!d.limit("charge:all", MACHINE_LIMITS.chargesPerDay, DAY)) return no(429, "DAILY_CAP", "today's machine charges are used up; try again tomorrow");
  return { ok: true, charge: await settle(d, d.newChargeId(), amount, meterKwh(amount), "visitor") };
}

/** One charge through the shared machinery: a meter reading priced at exactly `amount`, then the stored view. */
async function settle(d: MachineDeps, id: string, amount: bigint, kWh: string, by: "visitor" | "robot"): Promise<ChargeView> {
  const now = d.nowSecs();
  const reading: MeterReading = { padId: d.padId, robotId: d.robotId, kWh, startedAt: now - 600, endedAt: now, priceMicroUsdc: amount, nonce: id };
  const r = await d.charge({ chargeId: id, amount, reading });
  const rec: ChargeRecord = (await d.ledger.get(id)) ?? {};
  const view: ChargeView = {
    id, at: now, amount: usdc(amount), kWh, deal: rec.deal, deliveryHash: rec.deliveryHash, openSig: rec.openSig, deliverSig: rec.deliverSig,
    releaseSig: rec.releaseSig, padEventTx: rec.padEventTx, robotEventTx: rec.robotEventTx, by,
    ...(r.ok ? {} : { refused: { reason: r.reason, message: r.message } }),
  };
  await d.history.add(view);
  return view;
}

/**
 * The robot's own charge (#253), internal only: the public route still accepts just "0.40" / "0.60". The amount is the
 * decision's (whole cents, already capped by the mandate); anything else is refused here before anything runs.
 */
export async function runRobotCharge(d: MachineDeps, amount: bigint, kWh: string): Promise<ChargeView> {
  const id = d.newChargeId();
  if (amount <= 0n || amount % 10_000n !== 0n || !/^\d+\.\d{3}$/.test(kWh)) {
    return { id, at: d.nowSecs(), amount: usdc(amount > 0n ? amount : 0n), kWh, by: "robot", refused: { reason: "BAD_AMOUNT", message: "the decided amount must be whole cents" } };
  }
  return settle(d, id, amount, kWh, "robot");
}

/** Totals over the stored history: only settled charges count as paid; peaq events are counted as written. */
export function totals(h: ChargeView[]) {
  const settled = h.filter((c) => c.releaseSig);
  const toMilli = (s: string) => { const [a, b = ""] = s.split("."); return BigInt(a!) * 1000n + BigInt((b + "000").slice(0, 3)); };
  const kwhMilli = settled.reduce((s, c) => s + toMilli(c.kWh), 0n);
  // amounts are "N.NN" strings; robot charges are any whole cents, so parse rather than look up the two fixed ones
  const toMicro = (s: string) => { const [a, b = ""] = s.split("."); return BigInt(a!) * USDC + BigInt((b + "000000").slice(0, 6)); };
  const paid = settled.reduce((s, c) => s + toMicro(c.amount), 0n);
  return {
    charges: settled.length,
    refused: h.filter((c) => c.refused && !c.openSig).length,
    kWh: `${kwhMilli / 1000n}.${(kwhMilli % 1000n).toString().padStart(3, "0")}`,
    usdc: usdc(paid),
    peaqEvents: h.reduce((n, c) => n + (c.padEventTx ? 1 : 0) + (c.robotEventTx ? 1 : 0), 0),
  };
}

// ---------- storage: one record per charge (the agents ledger) + a short history for the page ----------

export type ChargeHistory = { list(): Promise<ChargeView[]>; add(v: ChargeView): Promise<void> };
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = <T>(b: Uint8Array | null): T | null => (b ? (JSON.parse(new TextDecoder().decode(b)) as T) : null);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Storage names are base58 (lib/storage.ts), so a record is named by the base58 of sha256(its id). */
const b58name = (prefix: string, key: string) => `${prefix}/${getBase58Decoder().decode(createHash("sha256").update(key).digest())}.json`;

export function blobLedger(blobs: Blobs): ChargeLedger {
  const name = async (id: string) => {
    if (!SAFE_ID.test(id)) throw new TypeError("charge id");
    return b58name("charges", id);
  };
  return { get: async (id) => dec<ChargeRecord>(await blobs.read(await name(id))) ?? undefined, put: async (id, r) => blobs.write(await name(id), enc(r)) };
}

export function blobHistory(blobs: Blobs, max: number = MACHINE_LIMITS.history): ChargeHistory {
  const file = b58name("history", "machines-history-v1");
  const list = async () => dec<ChargeView[]>(await blobs.read(file)) ?? [];
  return {
    list,
    add: async (v) => blobs.write(file, enc([v, ...(await list()).filter((x) => x.id !== v.id)].slice(0, max))),
  };
}

// ---------- simulate first, send only if the simulation passes ----------

/** The program error code inside a simulation error ({ InstructionError: [i, { Custom: n }] }), if any. */
export function simulationErrorCode(err: unknown): number | undefined {
  const ie = (err as { InstructionError?: unknown })?.InstructionError;
  if (!Array.isArray(ie)) return undefined;
  const custom = (ie[1] as { Custom?: unknown })?.Custom;
  return typeof custom === "number" ? custom : typeof custom === "bigint" ? Number(custom) : undefined;
}

/** null = the simulation passed; otherwise the RPC's error object. */
export type Simulate = (ixs: Parameters<DealClient["sendTransaction"]>[0]) => Promise<unknown | null>;

/**
 * A DealClient that simulates every transaction and sends it only if the simulation passes. A program error is
 * thrown in the shape the chain library names (context.code), so a refusal comes back as e.g. "OverPerTxCap" and
 * nothing reaches the chain. (The default client still sends after a failed estimate, so a refusal would land.)
 */
export function simulateFirst(inner: DealClient, simulate: Simulate): DealClient {
  return {
    rpc: inner.rpc,
    async sendTransaction(ixs) {
      const err = await simulate(ixs);
      if (err !== null && err !== undefined) {
        const code = simulationErrorCode(err);
        throw Object.assign(new Error(code !== undefined ? `simulation refused (custom ${code})` : "simulation failed"), { context: { code } });
      }
      return inner.sendTransaction(ixs);
    },
  };
}

// ---------- the robot's own tick (#253): battery, decision log, one decision per 30-minute slot ----------

export const SLOT_SECS = 1800;
export type StoredBattery = Battery & { lastSlot: number };
export type RobotDecision = { at: number; action: "wait" | "charge"; kWh?: string; amount?: string; reason: string; by: "robot" | "claude" | "simulated"; chargeId?: string };
export type BatteryStore = { get(): Promise<StoredBattery | null>; put(b: StoredBattery): Promise<void> };
export type DecisionLog = { list(): Promise<RobotDecision[]>; add(x: RobotDecision): Promise<void> };
export const DECISION_LOG = 30;

export type RobotTickDeps = {
  battery: BatteryStore;
  decisions: DecisionLog;
  mandate: () => Promise<MandateLeft>;
  /** The internal robot charge (runRobotCharge on the shared machinery). */
  charge: (amount: bigint, kWh: string, by: "robot") => Promise<ChargeView>;
  /** Optional: when present, use this decider instead of the robot's deterministic rule. Returns a decision with `by`. */
  decider?: (b: Battery, mandate: MandateLeft) => Promise<{ action: "wait" | "charge"; kWh?: string; amount?: bigint; reason: string; by: "robot" | "claude" | "simulated" }>;
};
export type TickResult = { decision: RobotDecision; battery: StoredBattery; duplicate?: true; charge?: ChargeView };

/** The simulated battery as the page shows it: advanced to now, not stored. First sight is 60 %. */
export function displayBattery(stored: StoredBattery | null, nowSecs: number) {
  const b = advance(stored ?? { levelPct: 60, updatedAt: nowSecs }, nowSecs, DEFAULT_ROBOT);
  return { levelPct: Math.round(b.levelPct * 10) / 10, updatedAt: b.updatedAt, simulated: true as const };
}

let tickLock: Promise<unknown> = Promise.resolve();

/** One tick: at most one decision per slot, at most one charge per tick. Serialized in this process. */
export function robotTick(d: RobotTickDeps, nowSecs: number): Promise<TickResult> {
  const run = tickLock.then(() => tickOnce(d, nowSecs));
  tickLock = run.catch(() => undefined);
  return run;
}

async function tickOnce(d: RobotTickDeps, now: number): Promise<TickResult> {
  const slot = Math.floor(now / SLOT_SECS);
  const stored = await d.battery.get();
  if (stored && stored.lastSlot === slot) {
    const last = (await d.decisions.list())[0] ?? { at: stored.updatedAt, action: "wait" as const, reason: "already decided in this slot", by: "robot" as const };
    return { decision: last, battery: stored, duplicate: true };
  }
  const b = advance(stored ?? { levelPct: 60, updatedAt: now }, now, DEFAULT_ROBOT);
  const mandate = await d.mandate();

  // Use the decider if present, otherwise the robot's rule
  let dec: { action: "wait" | "charge"; kWh?: string; amount?: bigint; reason: string; by: "robot" | "claude" | "simulated" };
  if (d.decider) {
    dec = await d.decider(b, mandate);
  } else {
    const robotDecision = decide(b, mandate, DEFAULT_ROBOT);
    dec = { ...robotDecision, by: "robot" as const };
  }

  if (dec.action === "wait") {
    const battery = { levelPct: b.levelPct, updatedAt: b.updatedAt, lastSlot: slot };
    const decision: RobotDecision = { at: now, action: "wait", reason: dec.reason, by: dec.by };
    await d.battery.put(battery);
    await d.decisions.add(decision);
    return { decision, battery };
  }
  // Claim the slot before paying: a crash or a retry mid-charge must never pay twice.
  await d.battery.put({ levelPct: b.levelPct, updatedAt: b.updatedAt, lastSlot: slot });
  const amount = dec.amount ?? 0n;
  const kWh = dec.kWh ?? "0.000";
  const base = { at: now, action: "charge" as const, kWh, amount: usdc(amount), by: dec.by };
  let view: ChargeView;
  try {
    view = await d.charge(amount, kWh, "robot");
  } catch {
    const decision: RobotDecision = { ...base, reason: `${dec.reason}; the charge could not complete` };
    await d.decisions.add(decision);
    return { decision, battery: { levelPct: b.levelPct, updatedAt: b.updatedAt, lastSlot: slot } };
  }
  // Money moved iff the release landed. A later failure (e.g. a peaq event write) must not make the robot re-buy energy it paid for.
  const paid = Boolean(view.releaseSig);
  const reason = paid
    ? view.refused ? `${dec.reason}; peaq event pending (${view.refused.reason})` : dec.reason
    : `refused (${view.refused?.reason ?? "not settled"}): ${view.refused?.message ?? dec.reason}`;
  const decision: RobotDecision = { ...base, reason, chargeId: view.id };
  const after = paid ? afterCharge(b, kWh, now, DEFAULT_ROBOT) : b;
  const battery = { levelPct: after.levelPct, updatedAt: after.updatedAt, lastSlot: slot };
  await d.battery.put(battery);
  await d.decisions.add(decision);
  return { decision, battery, charge: view };
}

export function blobBattery(blobs: Blobs): BatteryStore {
  const file = b58name("battery", "machines-battery-v1");
  return { get: async () => dec<StoredBattery>(await blobs.read(file)), put: async (b) => blobs.write(file, enc(b)) };
}

export function blobDecisions(blobs: Blobs, max: number = DECISION_LOG): DecisionLog {
  const file = b58name("decisions", "machines-decisions-v1");
  const list = async () => dec<RobotDecision[]>(await blobs.read(file)) ?? [];
  return { list, add: async (x) => blobs.write(file, enc([x, ...(await list())].slice(0, max))) };
}
