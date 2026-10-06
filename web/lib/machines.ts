// /machines (#229, peaq track): a simulated delivery robot pays a simulated charging pad on devnet, settled on the
// pad's signed meter reading, with peaq events for both machines. This module is the testable logic; the chain,
// peaq and storage wiring is in machines-server.ts. Every transaction is simulated first and sent only if the
// simulation passes, so the over-limit button is refused by the program and nothing is sent.
import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import type { DealClient } from "@deal/chain";
import type { ChargeLedger, ChargeRecord, MeterReading } from "@deal/agents/machines";
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
  const id = d.newChargeId();
  const now = d.nowSecs();
  const kWh = meterKwh(amount);
  const reading: MeterReading = { padId: d.padId, robotId: d.robotId, kWh, startedAt: now - 600, endedAt: now, priceMicroUsdc: amount, nonce: id };
  const r = await d.charge({ chargeId: id, amount, reading });
  const rec: ChargeRecord = (await d.ledger.get(id)) ?? {};
  const view: ChargeView = {
    id, at: now, amount: usdc(amount), kWh, deal: rec.deal, deliveryHash: rec.deliveryHash, openSig: rec.openSig, deliverSig: rec.deliverSig,
    releaseSig: rec.releaseSig, padEventTx: rec.padEventTx, robotEventTx: rec.robotEventTx,
    ...(r.ok ? {} : { refused: { reason: r.reason, message: r.message } }),
  };
  await d.history.add(view);
  return { ok: true, charge: view };
}

/** Totals over the stored history: only settled charges count as paid; peaq events are counted as written. */
export function totals(h: ChargeView[]) {
  const settled = h.filter((c) => c.releaseSig);
  const toMilli = (s: string) => { const [a, b = ""] = s.split("."); return BigInt(a!) * 1000n + BigInt((b + "000").slice(0, 3)); };
  const kwhMilli = settled.reduce((s, c) => s + toMilli(c.kWh), 0n);
  const paid = settled.reduce((s, c) => s + MACHINE_LIMITS.amounts[c.amount.slice(0, 4)]!, 0n);
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
