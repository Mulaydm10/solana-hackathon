// A charging pad's meter reading (#227): canonical JSON, signed by the pad's ed25519 key. Its sha256 is the delivery
// hash the pad submits on chain and the robot names when it releases, so the USDC moves only for this exact reading.
// The machines are simulated; the signature and hash are real.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type MeterReading = {
  padId: string;
  robotId: string;
  /** Decimal string, e.g. "1.25"; never a float, so the hash is stable. */
  kWh: string;
  /** Unix seconds. */
  startedAt: number;
  endedAt: number;
  /** The price of this charge in USDC base units (micro-USDC). */
  priceMicroUsdc: bigint;
  /** Unique per charge, so two identical sessions never share a delivery hash. */
  nonce: string;
};

const KWH = /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/;

/** Throws on a malformed reading: a programming error, never an expected refusal. */
export function assertReading(r: MeterReading): void {
  if (!r.padId || !r.robotId || !r.nonce) throw new TypeError("meter reading: padId, robotId and nonce are required");
  if (!KWH.test(r.kWh)) throw new TypeError("meter reading: kWh must be a decimal string with up to 3 decimals");
  if (!Number.isSafeInteger(r.startedAt) || !Number.isSafeInteger(r.endedAt) || r.endedAt < r.startedAt || r.startedAt < 0) {
    throw new TypeError("meter reading: startedAt/endedAt must be unix seconds with endedAt >= startedAt");
  }
  if (typeof r.priceMicroUsdc !== "bigint" || r.priceMicroUsdc <= 0n) throw new TypeError("meter reading: priceMicroUsdc must be a positive bigint");
}

/** Canonical bytes: fixed key order, bigint as a decimal string, no whitespace. */
export function canonicalReading(r: MeterReading): Uint8Array {
  assertReading(r);
  const ordered = {
    endedAt: r.endedAt, kWh: r.kWh, nonce: r.nonce, padId: r.padId, priceMicroUsdc: r.priceMicroUsdc.toString(),
    robotId: r.robotId, startedAt: r.startedAt,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export const readingHash = (r: MeterReading): Uint8Array => sha256(canonicalReading(r));

/** The pad signs the canonical reading; `deliveryHash` = sha256(canonical reading). */
export function signReading(r: MeterReading, padSecret: Uint8Array): { reading: MeterReading; signature: Uint8Array; deliveryHash: Uint8Array } {
  const bytes = canonicalReading(r);
  return { reading: { ...r }, signature: ed25519.sign(bytes, padSecret), deliveryHash: sha256(bytes) };
}

/** False for a bad signature, a different key or a malformed reading; never throws. */
export function verifyReading(r: MeterReading, signature: Uint8Array, padPublic: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, canonicalReading(r), padPublic);
  } catch {
    return false;
  }
}
