// "Charge on delivery" (#227, peaq track): a simulated delivery robot buys charging from a simulated charging pad.
// The robot's agent opens an escrow deal under its mission mandate (the owner set the rules once), the pad accepts and
// delivers the sha256 of its signed meter reading, the robot releases exactly that reading, and the settlement is
// written to peaq for both machines. Uses only instructions already on the devnet program; adds none.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deals, missions, type DealContext } from "@deal/chain";
import type { Address, TransactionSigner } from "@solana/kit";
import { signReading, type MeterReading } from "./meter.ts";
import type { PeaqClient, Settlement } from "./peaq.ts";

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
type Sent<T = object> = Ok<{ signature: string } & T> | Refused;
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

/** The chain steps of one charge, each signed by the machine that owns it. Program refusals come back by name. */
export interface ChargeChain {
  /** Robot agent: opens the escrow deal for `amount` to the pad (mandate: cap, per-payment cap, payee list). */
  openDeal(chargeId: string, amount: bigint, termsHash: Uint8Array): Promise<Sent<{ deal: Address }>>;
  /** Pad: accepts the deal. */
  accept(deal: Address): Promise<Sent>;
  /** Pad: records the delivery hash (sha256 of its signed meter reading) and its invoice. */
  deliver(deal: Address, deliveryHash: Uint8Array, invoice: bigint): Promise<Sent>;
  /** Robot agent: releases exactly the delivery it names. */
  release(deal: Address, deliveryHash: Uint8Array): Promise<Sent>;
}

/** Progress of one charge, saved after every step so a retry resumes instead of repeating. */
export type ChargeRecord = {
  deal?: Address; openSig?: string; acceptSig?: string; deliverSig?: string; releaseSig?: string;
  deliveryHash?: string; padEventTx?: string; robotEventTx?: string;
};

export interface ChargeLedger {
  get(chargeId: string): Promise<ChargeRecord | undefined>;
  put(chargeId: string, record: ChargeRecord): Promise<void>;
}

export type ChargeDeps = {
  chain: ChargeChain;
  peaq: PeaqClient;
  ledger: ChargeLedger;
  /** The pad's ed25519 meter key (32-byte seed); the public key is checked against `padPublic`. */
  padSecret: Uint8Array;
  padPublic: Uint8Array;
  robotMachineId: bigint;
  padMachineId: bigint;
};

export type ChargeResult = Ok<{
  deal: Address; openSig: string; deliverSig: string; releaseSig: string; padEventTx: string; robotEventTx: string; deliveryHash: Uint8Array;
}>;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The deal's terms: binds the charge id, both machines and the amount (sha256 of canonical JSON). */
export function chargeTermsHash(chargeId: string, r: MeterReading, amount: bigint): Uint8Array {
  return sha256(new TextEncoder().encode(JSON.stringify({ amount: amount.toString(), chargeId, kind: "fiducia-charge-v1", padId: r.padId, robotId: r.robotId })));
}

/** Deal id from the charge id, so the same charge always maps to the same deal (u64, never 0). */
export function chargeDealId(chargeId: string): bigint {
  const h = sha256(new TextEncoder().encode(`fiducia-charge:${chargeId}`));
  let id = 0n;
  for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(h[i]!);
  return id === 0n ? 1n : id;
}

const running = new Map<string, Promise<unknown>>();
/** One run per charge id at a time in this process: a second call waits, then resumes from the ledger. */
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  running.set(key, next.catch(() => {}));
  return next;
}

/**
 * Runs one charge end to end, or resumes it. Never throws for expected refusals.
 * Before anything is sent: the reading must be signed by the pad and priced at `amount`.
 * An over-limit amount is refused by the program at `openDeal` (simulated first; nothing lands).
 * Idempotent per `chargeId`: every completed step is in the ledger and is never repeated.
 */
export function charge(deps: ChargeDeps, req: { chargeId: string; amount: bigint; reading: MeterReading }): Promise<ChargeResult | Refused> {
  return serialized(req.chargeId, () => run(deps, req));
}

async function run(deps: ChargeDeps, req: { chargeId: string; amount: bigint; reading: MeterReading }): Promise<ChargeResult | Refused> {
  const { chargeId, amount, reading } = req;
  if (!chargeId || chargeId.length > 64) return refuse("BAD_CHARGE_ID", "chargeId must be 1 to 64 characters");
  if (amount <= 0n) return refuse("BAD_AMOUNT", "amount must be positive");
  if (reading.priceMicroUsdc !== amount) return refuse("READING_MISMATCH", "the meter reading's price is not the amount being paid");
  if (!same(ed25519.getPublicKey(deps.padSecret), deps.padPublic)) return refuse("WRONG_PAD_KEY", "the pad key does not match the pad's public key");
  let signed;
  try {
    signed = signReading(reading, deps.padSecret);
  } catch {
    return refuse("BAD_READING", "the meter reading is malformed");
  }
  const rec: ChargeRecord = { ...(await deps.ledger.get(chargeId)) };
  if (rec.deliveryHash && rec.deliveryHash !== hex(signed.deliveryHash)) {
    return refuse("CHARGE_ID_REUSED", "this charge id was already used for a different meter reading");
  }
  rec.deliveryHash = hex(signed.deliveryHash);
  const save = () => deps.ledger.put(chargeId, { ...rec });

  if (!rec.openSig || !rec.deal) {
    const r = await deps.chain.openDeal(chargeId, amount, chargeTermsHash(chargeId, reading, amount));
    if (!r.ok) return r;
    rec.deal = r.deal;
    rec.openSig = r.signature;
    await save();
  }
  const deal = rec.deal;
  if (!rec.acceptSig) {
    const r = await deps.chain.accept(deal);
    if (!r.ok) return r;
    rec.acceptSig = r.signature;
    await save();
  }
  if (!rec.deliverSig) {
    const r = await deps.chain.deliver(deal, signed.deliveryHash, amount);
    if (!r.ok) return r;
    rec.deliverSig = r.signature;
    await save();
  }
  if (!rec.releaseSig) {
    const r = await deps.chain.release(deal, signed.deliveryHash);
    if (!r.ok) return r;
    rec.releaseSig = r.signature;
    await save();
  }
  const s: Settlement = { chargeId, deal, releaseSignature: rec.releaseSig, deliveryHash: signed.deliveryHash, amount };
  if (!rec.padEventTx) {
    const r = await deps.peaq.submitRevenueEvent(deps.padMachineId, s);
    if (!r.ok) return r;
    rec.padEventTx = r.txHash;
    await save();
  }
  if (!rec.robotEventTx) {
    const r = await deps.peaq.submitActivityEvent(deps.robotMachineId, s);
    if (!r.ok) return r;
    rec.robotEventTx = r.txHash;
    await save();
  }
  return {
    ok: true, deal, openSig: rec.openSig, deliverSig: rec.deliverSig, releaseSig: rec.releaseSig,
    padEventTx: rec.padEventTx, robotEventTx: rec.robotEventTx, deliveryHash: signed.deliveryHash,
  };
}

/** An in-memory ledger (tests, single process). A durable one implements the same two calls. */
export function memoryLedger(): ChargeLedger & { all(): Map<string, ChargeRecord> } {
  const m = new Map<string, ChargeRecord>();
  return { get: async (id) => (m.has(id) ? { ...m.get(id)! } : undefined), put: async (id, r) => void m.set(id, { ...r }), all: () => m };
}

/**
 * The real chain steps through `@deal/chain` (the robot agent's mandate and the pad as seller). Each step is safe to
 * repeat (the library checks chain state before resending), and a program refusal is returned by its name.
 */
export function chainChargeChain(
  ctx: DealContext,
  o: { mission: Address; robot: TransactionSigner; pad: TransactionSigner; now: () => number; dealSecs?: number; reviewSecs?: number },
): ChargeChain {
  return {
    openDeal: (chargeId, amount, termsHash) =>
      missions.openDeal(ctx, o.robot, o.mission, {
        seller: o.pad.address, dealId: chargeDealId(chargeId), amount, termsHash,
        deadline: BigInt(Math.floor(o.now()) + (o.dealSecs ?? 3_600)), ...(o.reviewSecs !== undefined ? { reviewSecs: o.reviewSecs } : {}),
      }, termsHash),
    accept: (deal) => deals.accept(ctx, o.pad, deal),
    deliver: (deal, deliveryHash, invoice) => deals.deliver(ctx, o.pad, deal, deliveryHash, invoice),
    release: (deal, deliveryHash) => missions.release(ctx, o.robot, o.mission, deal, deliveryHash),
  };
}
