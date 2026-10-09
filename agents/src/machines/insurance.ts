// Parametric downtime insurance (peaq v2, #271) on the existing escrow, no program change. The insurer is the BUYER of a
// deal for `coverage`, the pad the SELLER, a verifier is set, and the deal deadline is the end of the term. The pad pays
// the premium to the insurer (an SPL transfer). If the pad's signed heartbeats stop for longer than OUTAGE_AFTER_SECS
// the pad's insurer-side proof is filed as the delivery (deliver with the outage-proof hash), an outage event is written
// to peaq, and after the review window anyone claims: the coverage goes to the pad. With no outage the deal times out
// and anyone refunds the insurer. Heartbeats are SIMULATED and labelled so elsewhere; the signatures and payments are real.
// One idempotent step per call; the caller saves the returned policy. Never throws; a failed step returns the progress
// made so far plus the reason.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ata, deals, safeSend, type DealContext } from "@deal/chain";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { chargeDealId } from "./charge.ts";
import { outageHash, outageProof, OUTAGE_AFTER_SECS, type Heartbeat } from "./heartbeat.ts";
import type { PeaqClient } from "./peaq.ts";
import type { Grade } from "./score.ts";

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
type Sent<T = object> = Ok<{ signature: string } & T> | Refused;
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

/** Annual-style rate per 24 h of term, in basis points of the coverage, by the pad's grade. */
export const PREMIUM_RATE_BPS: Record<Grade, number> = { AAA: 200, AA: 300, A: 400, BBB: 600, BB: 900, B: 1200, NR: 2000, Provisioned: 2000 };

const CENT = 10_000n; // USDC base units per cent
const DAY = 86_400n;

/** coverage x rate x (term / 24 h), rounded UP to a whole cent, at least 0.01 USDC. Integer math only. */
export function quotePremium(coverage: bigint, grade: Grade, termSecs: number): Ok<{ premium: bigint; rateBps: number }> | Refused {
  const rateBps = Object.hasOwn(PREMIUM_RATE_BPS, grade) ? PREMIUM_RATE_BPS[grade] : undefined;
  if (rateBps === undefined) return refuse("BAD_GRADE", `no premium rate for grade ${String(grade)}`);
  if (typeof coverage !== "bigint" || coverage <= 0n) return refuse("BAD_COVERAGE", "coverage must be a positive amount");
  if (!Number.isSafeInteger(termSecs) || termSecs <= 0) return refuse("BAD_TERM", "the term must be a positive whole number of seconds");
  const den = 10_000n * DAY;
  const raw = (coverage * BigInt(rateBps) * BigInt(termSecs) + den - 1n) / den; // ceil, base units
  let premium = ((raw + CENT - 1n) / CENT) * CENT; // ceil to a whole cent
  if (premium < CENT) premium = CENT;
  return { ok: true, premium, rateBps };
}

export type Policy = {
  id: string; pad: string; coverage: bigint; premium: bigint; grade: Grade; termStart: number; termEnd: number;
  status: "quoted" | "active" | "claimed" | "paid" | "expired" | "challenged"; deal?: Address; openSig?: string;
  acceptSig?: string; premiumSig?: string; claimSig?: string; payoutSig?: string; refundSig?: string;
  outage?: { proofHash: string; detectedAt: number; gapSecs: number; peaqEventTx?: string };
  /** Why the last step did not finish (added by #271; absent when the last step succeeded). */
  reason?: string;
};

export interface InsuranceChain {
  /** Insurer: create_deal for `coverage`, seller = pad, verifier set, deadline = termEnd. */
  openPolicy(policyId: string, coverage: bigint, termEnd: number, termsHash: Uint8Array): Promise<Sent<{ deal: Address }>>;
  /** Pad. */
  accept(deal: Address): Promise<Sent>;
  /** Pad -> insurer SPL transfer (memo = policy id). */
  payPremium(amount: bigint, policyId: string): Promise<Sent>;
  /** Pad: submit_delivery with the outage-proof hash, invoice = coverage. */
  fileClaim(deal: Address, proofHash: Uint8Array, coverage: bigint): Promise<Sent>;
  /** Insurer, only for an invalid proof. */
  challenge(deal: Address): Promise<Sent>;
  /** Anyone, after the review window. */
  claim(deal: Address): Promise<Sent>;
  /** Anyone, after termEnd with no claim. */
  refund(deal: Address): Promise<Sent>;
}

export type InsuranceDeps = { chain: InsuranceChain; peaq: PeaqClient; padMachineId: bigint; padAddress: `0x${string}` };

/** The terms both sides sign up to: sha256 of canonical JSON over the policy's fixed fields. */
export function policyTermsHash(p: Pick<Policy, "id" | "pad" | "coverage" | "premium" | "grade" | "termStart" | "termEnd">): Uint8Array {
  return sha256(new TextEncoder().encode(JSON.stringify({
    coverage: p.coverage.toString(), grade: p.grade, id: p.id, pad: p.pad, premium: p.premium.toString(), termEnd: p.termEnd, termStart: p.termStart,
  })));
}

const failed = (p: Policy, reason: string): Policy => ({ ...p, reason });
const errMsg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 120) : "error");

/**
 * One step. quoted -> (open, accept, premium) -> active. active + outage -> file claim + peaq outage event -> claimed.
 * claimed + review window passed -> claim -> paid. active past termEnd -> refund -> expired. Anything else is returned as is.
 */
export async function insuranceStep(
  deps: InsuranceDeps, p: Policy, o: { nowSecs: number; lastBeat: Heartbeat | null; reviewSecs: number },
): Promise<Policy> {
  try {
    switch (p.status) {
      case "quoted": return await quoted(deps, p, o.nowSecs);
      case "active": return await active(deps, p, o);
      case "claimed": return await claimed(deps, p, o);
      default: return p; // paid, expired, challenged: terminal here
    }
  } catch (e) {
    return failed(p, `insurance step failed (${errMsg(e)})`);
  }
}

async function quoted(deps: InsuranceDeps, p0: Policy, nowSecs: number): Promise<Policy> {
  let p = p0;
  if (nowSecs >= p.termEnd && !p.deal) return failed(p, "the term is over before the policy was opened");
  if (!p.deal) {
    const r = await deps.chain.openPolicy(p.id, p.coverage, p.termEnd, policyTermsHash(p));
    if (!r.ok) return failed(p, `open: ${r.reason}`);
    p = { ...p, deal: r.deal, openSig: r.signature };
  }
  if (!p.acceptSig) {
    const r = await deps.chain.accept(p.deal!);
    if (!r.ok) return failed(p, `accept: ${r.reason}`);
    p = { ...p, acceptSig: r.signature };
  }
  if (!p.premiumSig) {
    const r = await deps.chain.payPremium(p.premium, p.id);
    if (!r.ok) return failed(p, `premium: ${r.reason}`);
    p = { ...p, premiumSig: r.signature };
  }
  const { reason: _r, ...rest } = p;
  return { ...rest, status: "active" };
}

async function active(deps: InsuranceDeps, p: Policy, o: { nowSecs: number; lastBeat: Heartbeat | null }): Promise<Policy> {
  if (!p.deal) return failed(p, "an active policy has no deal");
  if (o.nowSecs >= p.termEnd) {
    const r = await deps.chain.refund(p.deal);
    if (!r.ok) return failed(p, `refund: ${r.reason}`);
    const { reason: _r, ...rest } = p;
    return { ...rest, status: "expired", refundSig: r.signature };
  }
  const beat = o.lastBeat;
  if (!beat || o.nowSecs - beat.sentAt <= OUTAGE_AFTER_SECS) return p; // up, or nothing to prove an outage with
  const proof = outageProof(deps.padMachineId.toString(), p.id, beat, o.nowSecs);
  const hash = outageHash(proof);
  const r = await deps.chain.fileClaim(p.deal, hash, p.coverage);
  if (!r.ok) return failed(p, `claim: ${r.reason}`);
  const { reason: _r, ...rest } = p;
  const filed: Policy = {
    ...rest, status: "claimed", claimSig: r.signature, outage: { proofHash: bytesToHex(hash), detectedAt: o.nowSecs, gapSecs: proof.gapSecs },
  };
  return recordOutageEvent(deps, filed);
}

/** Writes the peaq outage event once; a failure is kept as the reason and retried on the next step. */
async function recordOutageEvent(deps: InsuranceDeps, p: Policy): Promise<Policy> {
  const out = p.outage;
  if (!out || out.peaqEventTx) return p;
  const e = await deps.peaq.submitOutageEvent(deps.padMachineId, { gapSecs: out.gapSecs, proofHash: out.proofHash, policy: p.id });
  if (!e.ok) return failed(p, `peaq outage event: ${e.reason}`);
  const { reason: _r, ...rest } = p;
  return { ...rest, outage: { ...out, peaqEventTx: e.txHash } };
}

async function claimed(deps: InsuranceDeps, p0: Policy, o: { nowSecs: number; reviewSecs: number }): Promise<Policy> {
  if (!p0.deal || !p0.outage) return failed(p0, "a claimed policy has no deal or outage record");
  const p = await recordOutageEvent(deps, p0); // a missed event must not hold the payout back, but is retried first
  if (o.nowSecs < p.outage!.detectedAt + o.reviewSecs) return p;
  const r = await deps.chain.claim(p.deal!);
  if (!r.ok) return failed(p, `payout: ${r.reason}`);
  const { reason: _r, ...rest } = p;
  return { ...rest, status: "paid", payoutSig: r.signature };
}

// ---------- the real chain ----------

/** Deal id from the policy id (own namespace). */
export const policyDealId = (policyId: string): bigint => chargeDealId(`policy:${policyId}`);

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const USDC_DECIMALS = 6;
const premiumMemo = (policyId: string) => `fiducia-premium:${policyId}`;

/**
 * The real steps through `@deal/chain`. Insurer = buyer, pad = seller, `verifier` set, deadline = termEnd. The premium is
 * an SPL transfer pad -> insurer with a memo; a resend after an uncertain failure first looks for that memo, so the
 * premium is never paid twice.
 */
export function chainInsuranceChain(
  ctx: DealContext,
  o: { insurer: TransactionSigner; pad: TransactionSigner; verifier: Address; now: () => number; reviewSecs: number },
): InsuranceChain {
  return {
    openPolicy: (policyId, coverage, termEnd, termsHash) =>
      deals.open(ctx, o.insurer, {
        seller: o.pad.address, dealId: policyDealId(policyId), amount: coverage, termsHash,
        deadline: BigInt(termEnd), reviewSecs: o.reviewSecs, verifier: o.verifier,
      }),
    accept: (deal) => deals.accept(ctx, o.pad, deal),
    async payPremium(amount, policyId) {
      try {
        const source = await ata(ctx, o.pad.address);
        const destination = await ata(ctx, o.insurer.address);
        const memo = premiumMemo(policyId);
        const findPaid = async () => {
          const sigs = await ctx.client.rpc.getSignaturesForAddress(destination, { limit: 100, commitment: "confirmed" }).send();
          return sigs.find((s) => s.err === null && typeof s.memo === "string" && s.memo.includes(memo));
        };
        const before = await findPaid();
        if (before) return { ok: true, signature: String(before.signature) };
        return await safeSend(ctx, destination, async () => (await findPaid()) !== undefined, async (): Promise<Instruction[]> => [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: o.pad, owner: o.insurer.address, mint: ctx.mint }),
          getTransferCheckedInstruction({ source, mint: ctx.mint, destination, authority: o.pad, amount, decimals: USDC_DECIMALS }),
          { programAddress: MEMO_PROGRAM, data: new TextEncoder().encode(memo) },
        ], { exactlyOnce: true });
      } catch (e) {
        return refuse("CHAIN_ERROR", errMsg(e));
      }
    },
    fileClaim: (deal, proofHash, coverage) => deals.deliver(ctx, o.pad, deal, proofHash, coverage),
    challenge: (deal) => deals.challenge(ctx, o.insurer, deal),
    claim: (deal) => deals.claim(ctx, o.insurer, deal),
    refund: (deal) => deals.refund(ctx, o.insurer, deal),
  };
}
