// "The robot earns" (peaq v2, #270): a simulated shop pays the robot for each delivery on devnet escrow. The shop is the
// buyer (its own policy, create_deal), the robot the seller. The robot signs a drop-off (simulated, ed25519 over
// canonical JSON); its sha256 is the delivery hash the robot submits and the shop releases, so the USDC moves only for
// that exact drop-off. The release then becomes a peaq REVENUE event for the robot. Same shape as charge.ts: the
// ledger is saved after every step, so a retry resumes and never pays twice. Uses only instructions already on devnet.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deals, type DealContext } from "@deal/chain";
import type { Address, TransactionSigner } from "@solana/kit";
import { chargeDealId, type ChargeLedger, type ChargeRecord } from "./charge.ts";
import type { Battery } from "./autonomy.ts";
import type { PeaqClient, Settlement } from "./peaq.ts";

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
type Sent<T = object> = Ok<{ signature: string } & T> | Refused;
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

/** A simulated delivery drop-off, signed by the robot's Solana (ed25519) key. */
export type DropOff = { jobId: string; robotId: string; at: number; km: number };

/** Canonical bytes: fixed key order, no whitespace. */
export function canonicalDropOff(d: DropOff): Uint8Array {
  if (!d.jobId || !d.robotId) throw new TypeError("drop-off: jobId and robotId are required");
  if (!Number.isSafeInteger(d.at) || d.at < 0) throw new TypeError("drop-off: at must be unix seconds");
  if (!Number.isFinite(d.km) || d.km < 0) throw new TypeError("drop-off: km must be a non-negative number");
  return new TextEncoder().encode(JSON.stringify({ at: d.at, jobId: d.jobId, km: d.km, robotId: d.robotId }));
}

/** The robot signs the canonical drop-off; `deliveryHash` = sha256(canonical drop-off). Throws only on a malformed one. */
export function signDropOff(d: DropOff, robotSecret: Uint8Array): { dropOff: DropOff; signature: Uint8Array; deliveryHash: Uint8Array } {
  const bytes = canonicalDropOff(d);
  return { dropOff: { ...d }, signature: ed25519.sign(bytes, robotSecret), deliveryHash: sha256(bytes) };
}

/** False for a bad signature, another key or a malformed drop-off; never throws. */
export function verifyDropOff(d: DropOff, signature: Uint8Array, robotPublic: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, canonicalDropOff(d), robotPublic);
  } catch {
    return false;
  }
}

/** The chain steps of one job. Shop = buyer, robot = seller. Program refusals come back by name. */
export interface JobChain {
  /** Shop: opens the escrow deal for `amount` to the robot. */
  openDeal(jobId: string, amount: bigint, termsHash: Uint8Array): Promise<Sent<{ deal: Address }>>;
  /** Robot: accepts. */
  accept(deal: Address): Promise<Sent>;
  /** Robot: records the delivery hash (sha256 of its signed drop-off) and its invoice. */
  deliver(deal: Address, deliveryHash: Uint8Array, invoice: bigint): Promise<Sent>;
  /** Shop: releases exactly the delivery it names. */
  release(deal: Address, deliveryHash: Uint8Array): Promise<Sent>;
}

export type JobDeps = {
  chain: JobChain;
  peaq: PeaqClient;
  /** Same record shape as charges: deal, per-step signatures, deliveryHash, robotEventTx. */
  ledger: ChargeLedger;
  /** The robot's ed25519 key (32-byte seed). */
  robotSecret: Uint8Array;
  robotMachineId: bigint;
};

export type JobResult = Ok<{ deal: Address; releaseSig: string; robotEventTx: string }>;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The deal's terms: binds the job id, the robot and the amount (sha256 of canonical JSON). */
export function jobTermsHash(jobId: string, robotId: string, amount: bigint): Uint8Array {
  return sha256(new TextEncoder().encode(JSON.stringify({ amount: amount.toString(), jobId, kind: "fiducia-job-v1", robotId })));
}

/** Deal id from the job id (own namespace, so a job never collides with a charge). */
export const jobDealId = (jobId: string): bigint => chargeDealId(`job:${jobId}`);

const running = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  running.set(key, next.catch(() => {}));
  return next;
}

/**
 * Runs one delivery job end to end, or resumes it. Never throws for expected refusals.
 * Idempotent per `jobId`: every completed step is in the ledger and never repeated, so a peaq failure after the
 * release is retried on its own and the shop never pays twice.
 */
export function runJob(deps: JobDeps, req: { jobId: string; amount: bigint; km: number; nowSecs: number }): Promise<JobResult | Refused> {
  return serialized(req.jobId, () => run(deps, req));
}

async function run(deps: JobDeps, req: { jobId: string; amount: bigint; km: number; nowSecs: number }): Promise<JobResult | Refused> {
  const { jobId, amount } = req;
  if (!jobId || jobId.length > 64) return refuse("BAD_JOB_ID", "jobId must be 1 to 64 characters");
  if (amount <= 0n) return refuse("BAD_AMOUNT", "amount must be positive");
  const robotId = deps.robotMachineId.toString();
  const rec: ChargeRecord = { ...(await deps.ledger.get(jobId)) };
  // The drop-off time is fixed by the first run, so a resume signs the same bytes and gets the same delivery hash.
  const at = rec.deliveryHash ? undefined : Math.floor(req.nowSecs);
  let deliveryHash: Uint8Array;
  if (rec.deliveryHash) {
    deliveryHash = Uint8Array.from(Buffer.from(rec.deliveryHash, "hex"));
  } else {
    try {
      deliveryHash = signDropOff({ jobId, robotId, at: at!, km: req.km }, deps.robotSecret).deliveryHash;
    } catch {
      return refuse("BAD_DROP_OFF", "the drop-off is malformed");
    }
    rec.deliveryHash = hex(deliveryHash);
  }
  const save = () => deps.ledger.put(jobId, { ...rec });

  if (!rec.openSig || !rec.deal) {
    const r = await deps.chain.openDeal(jobId, amount, jobTermsHash(jobId, robotId, amount));
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
    const r = await deps.chain.deliver(deal, deliveryHash, amount);
    if (!r.ok) return r;
    rec.deliverSig = r.signature;
    await save();
  }
  if (!rec.releaseSig) {
    const r = await deps.chain.release(deal, deliveryHash);
    if (!r.ok) return r;
    rec.releaseSig = r.signature;
    await save();
  }
  if (!rec.robotEventTx) {
    const s: Settlement = { chargeId: jobId, deal, releaseSignature: rec.releaseSig, deliveryHash, amount };
    const r = await deps.peaq.submitRevenueEvent(deps.robotMachineId, s);
    if (!r.ok) return r;
    rec.robotEventTx = r.txHash;
    await save();
  }
  return { ok: true, deal, releaseSig: rec.releaseSig, robotEventTx: rec.robotEventTx };
}

export const JOB_DEFAULTS = { minPct: 35, everySecs: 4 * 3600, drainPct: 15, lowPct: 25 } as const;

/**
 * Pure: should the robot take a delivery job now? Needs battery >= minPct, `everySecs` since the last job, and the
 * trip (drainPct) must not take it below its own lowPct (default 25, the charging threshold). km is simulated.
 */
export function planJob(
  b: Battery, lastJobAt: number | null,
  o: { nowSecs: number; minPct?: number; everySecs?: number; drainPct?: number; lowPct?: number },
): { take: true; km: number } | { take: false; reason: string } {
  const minPct = o.minPct ?? JOB_DEFAULTS.minPct;
  const everySecs = o.everySecs ?? JOB_DEFAULTS.everySecs;
  const drainPct = o.drainPct ?? JOB_DEFAULTS.drainPct;
  const lowPct = o.lowPct ?? JOB_DEFAULTS.lowPct;
  const level = Math.round(b.levelPct);
  if (lastJobAt !== null && o.nowSecs - lastJobAt < everySecs) {
    const mins = Math.ceil((everySecs - (o.nowSecs - lastJobAt)) / 60);
    return { take: false, reason: `last job was recent: next one in ${mins} min` };
  }
  if (b.levelPct < minPct) return { take: false, reason: `battery ${level}% < ${minPct}%: too low to take a job` };
  if (b.levelPct - drainPct < lowPct) {
    return { take: false, reason: `battery ${level}% minus ${drainPct}% for the trip would drop below ${lowPct}%` };
  }
  return { take: true, km: drainPct / 5 };
}

/**
 * The real chain steps through `@deal/chain`: the shop opens the deal under its own policy (already initialised) and
 * releases; the robot accepts and delivers. Each step is safe to repeat; program refusals are returned by name.
 */
export function chainJobChain(
  ctx: DealContext,
  shop: { signer: TransactionSigner; now: () => number; dealSecs?: number; reviewSecs?: number },
  robot: TransactionSigner,
): JobChain {
  return {
    openDeal: (jobId, amount, termsHash) =>
      deals.open(ctx, shop.signer, {
        seller: robot.address, dealId: jobDealId(jobId), amount, termsHash,
        deadline: BigInt(Math.floor(shop.now()) + (shop.dealSecs ?? 3_600)), reviewSecs: shop.reviewSecs ?? 60,
      }),
    accept: (deal) => deals.accept(ctx, robot, deal),
    deliver: (deal, deliveryHash, invoice) => deals.deliver(ctx, robot, deal, deliveryHash, invoice),
    release: (deal, deliveryHash) => deals.release(ctx, shop.signer, deal, deliveryHash),
  };
}
