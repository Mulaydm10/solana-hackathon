// Pad heartbeats (peaq v2, #268): a charging pad signs a peaq-format message with its EVM key (EIP-191), the
// verifier checks it against the pad's address, and verified beats become uptime and an outage proof. The beats and
// the clock are inputs; nothing here reads the network or the time. Uptime figures are derived from simulated beats
// and labelled so; the signatures are real.
import { sha256 } from "@noble/hashes/sha2.js";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Heartbeat = {
  machineId: string;
  /** Unix seconds. */
  sentAt: number;
  signature: `0x${string}`;
  /** The pad's peaq EVM address. */
  address: `0x${string}`;
};

export type Gap = { from: number; to: number; secs: number };

/** Two missed 30-minute ticks + 5 minutes of grace. */
export const OUTAGE_AFTER_SECS = 3900;

/** The exact peaq heartbeat format: no trailing newline. */
export function heartbeatMessage(machineId: string, sentAt: number): string {
  return `machineId: ${machineId}\nsentAt: ${sentAt}`;
}

/** Signs the peaq heartbeat message with the pad's EVM key (EIP-191 personal sign). */
export async function signHeartbeat(machineId: string, sentAt: number, peaqPrivateKey: `0x${string}`): Promise<Heartbeat> {
  const account = privateKeyToAccount(peaqPrivateKey);
  const signature = await account.signMessage({ message: heartbeatMessage(machineId, sentAt) });
  return { machineId, sentAt, signature, address: account.address };
}

/** False for a bad signature, a different address or a malformed beat; never throws. */
export async function verifyHeartbeat(h: Heartbeat, expectedAddress: `0x${string}`): Promise<boolean> {
  try {
    if (h.address.toLowerCase() !== expectedAddress.toLowerCase()) return false;
    return await verifyMessage({
      address: expectedAddress,
      message: heartbeatMessage(h.machineId, h.sentAt),
      signature: h.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Uptime over [from, to]. Only verified beats are passed in. The window is split at each beat (the last beat before
 * `from` counts as covering the start of the window); a segment longer than outageAfterSecs is a gap and counts as
 * down, including the tail from the last beat to `to`. upPct = 100 x covered time / (to - from).
 */
export function uptime(beats: Heartbeat[], o: { from: number; to: number; outageAfterSecs: number }): { upPct: number; gaps: Gap[]; lastBeatAt: number | null } {
  const { from, to, outageAfterSecs } = o;
  if (to <= from) return { upPct: 0, gaps: [], lastBeatAt: null };
  const sorted = beats.filter((b) => b.sentAt <= to).sort((a, b) => a.sentAt - b.sentAt);
  const gaps: Gap[] = [];
  let down = 0;
  let last: number | null = null;
  const segment = (start: number, end: number) => {
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    const secs = e - s;
    if (secs > outageAfterSecs) {
      gaps.push({ from: s, to: e, secs });
      down += secs;
    }
  };
  for (const b of sorted) {
    if (b.sentAt >= from) segment(last ?? from, b.sentAt);
    last = b.sentAt;
  }
  segment(last ?? from, to);
  const upPct = (100 * (to - from - down)) / (to - from);
  return { upPct, gaps, lastBeatAt: last };
}

export type OutageProof = {
  kind: "fiducia-outage-v1";
  machineId: string;
  policy: string;
  lastBeat: Heartbeat;
  /** Unix seconds: when the outage was detected. */
  detectedAt: number;
  gapSecs: number;
};

export function outageProof(machineId: string, policy: string, lastBeat: Heartbeat, detectedAt: number): OutageProof {
  return { kind: "fiducia-outage-v1", machineId, policy, lastBeat, detectedAt, gapSecs: detectedAt - lastBeat.sentAt };
}

/** Fixed key order, numbers and strings only (no bigint), so the same proof always gives the same bytes. */
export function canonicalOutage(p: OutageProof): Uint8Array {
  const ordered = {
    kind: p.kind,
    machineId: p.machineId,
    policy: p.policy,
    lastBeat: {
      machineId: p.lastBeat.machineId,
      sentAt: p.lastBeat.sentAt,
      signature: p.lastBeat.signature,
      address: p.lastBeat.address,
    },
    detectedAt: p.detectedAt,
    gapSecs: p.gapSecs,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export const outageHash = (p: OutageProof): Uint8Array => sha256(canonicalOutage(p));

/**
 * The lastBeat verifies against the pad's address, its machine id matches, the gap is recomputed from the beat and
 * is longer than outageAfterSecs, and detection is not in the future. Never throws.
 */
export async function verifyOutageProof(p: OutageProof, padAddress: `0x${string}`, o: { outageAfterSecs: number; nowSecs: number }): Promise<boolean> {
  try {
    if (p.kind !== "fiducia-outage-v1") return false;
    if (p.lastBeat.machineId !== p.machineId) return false;
    if (!(await verifyHeartbeat(p.lastBeat, padAddress))) return false;
    if (p.gapSecs !== p.detectedAt - p.lastBeat.sentAt) return false;
    if (!(p.gapSecs > o.outageAfterSecs)) return false;
    if (p.detectedAt > o.nowSecs) return false;
    return true;
  } catch {
    return false;
  }
}
