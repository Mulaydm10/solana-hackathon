// What GET /api/machines/status adds for Machines v2 (#273): the network, scores, insurance and earnings, read from the
// stores only (no chain, no peaq). Amounts are decimal USDC strings. Heartbeats are verified on read. Server only.
import { OUTAGE_AFTER_SECS, uptime, type MachineScore } from "@deal/agents/machines";
import { totals, type ChargeView } from "./machines";
import { verifiedBeats, type NetworkConfig, type NetworkStore, type NotConfigured, type StepResult } from "./machines-network";

/** Micro-USDC as a decimal string with at least two decimals and no trailing zeros beyond that ("0.28", "0.285"). */
export function usdcExact(micro: bigint): string {
  const neg = micro < 0n;
  const m = neg ? -micro : micro;
  let frac = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${m / 1_000_000n}.${frac}`;
}
const microOf = (s: string) => { const [a, b = ""] = s.split("."); return BigInt(a!) * 1_000_000n + BigInt((b + "000000").slice(0, 6)); };

export type NetworkCard = {
  role: string; name: string; machineId: string; pricePerKwh: string; online: boolean; lastHeartbeatAt: number | null; upPct24h: number;
  score: number; grade: string; provisioned: boolean;
};
export type PolicyView = {
  id: string; pad: string; padAddress: string; coverage: string; premium: string; grade: string; termStart: number; termEnd: number; status: string;
  deal?: string; openSig?: string; acceptSig?: string; premiumSig?: string; claimSig?: string; challengeSig?: string; payoutSig?: string; refundSig?: string;
  outage?: { detectedAt: number; gapSecs: number; peaqEventTx?: string; insurerCheck?: "valid" | "invalid"; simulated: true };
  reason?: string;
};
export type NetworkStatus = {
  v2: { configured: true; lastTick: { at: number; steps: StepResult[] } | null };
  network: NetworkCard[];
  scores: Record<string, MachineScore>;
  insurance: { policies: PolicyView[] };
  earnings: { jobs: number; earned: string; spentOnEnergy: string; net: string; recent: { id: string; at: number; amount: string; deal: string | null; releaseSig: string | null; robotEventTx: string | null }[] };
};
export type NotConfiguredStatus = { v2: { configured: false; missing: NotConfigured } };

const NO_SCORE: MachineScore = { score: 0, grade: "Provisioned", provisioned: true, factors: { bond: 0, revenue: 0, activity: 0, tenure: 0, freshness: 0, penalty: 0 }, events: 0, outages7d: 0, explain: "Not scored yet: the first tick reads the machine's peaq events." };

export async function networkStatus(store: NetworkStore, cfg: NetworkConfig, history: ChargeView[], nowSecs: number): Promise<NetworkStatus> {
  const [power, cache, policies, jobs, lastTick] = await Promise.all([store.power(), store.scores(), store.policies(), store.jobs(), store.lastTick()]);
  const roleOf = new Map(cfg.pads.map((p) => [p.address as string, p.role]));
  const network: NetworkCard[] = [];
  for (const pad of cfg.pads) {
    const beats = await verifiedBeats(store, pad);
    const first = beats.length ? Math.min(...beats.map((b) => b.sentAt)) : null;
    const from = Math.max(nowSecs - 86_400, first ?? nowSecs);
    // Uptime is derived from simulated heartbeats; a window with no length yet (the first beat just landed) is 100 % while online.
    const up = first === null ? 0 : nowSecs - from <= 0 ? 100 : uptime(beats, { from, to: nowSecs, outageAfterSecs: OUTAGE_AFTER_SECS }).upPct;
    const sc = cache?.scores[pad.role] ?? NO_SCORE;
    network.push({
      role: pad.role, name: pad.name, machineId: pad.machineId.toString(), pricePerKwh: usdcExact(pad.pricePerKwhMicro), online: power[pad.role] !== false,
      lastHeartbeatAt: beats.at(-1)?.sentAt ?? null, upPct24h: Math.round(up * 10) / 10, score: sc.score, grade: sc.grade, provisioned: sc.provisioned,
    });
  }
  const scores: Record<string, MachineScore> = {};
  for (const k of ["robot", ...cfg.pads.map((p) => p.role)]) scores[k] = cache?.scores[k] ?? NO_SCORE;
  const views: PolicyView[] = [...policies].sort((a, b) => b.termStart - a.termStart).slice(0, 10).map((p) => ({
    id: p.id, pad: roleOf.get(p.pad) ?? p.pad, padAddress: p.pad, coverage: usdcExact(BigInt(p.coverage)), premium: usdcExact(BigInt(p.premium)), grade: p.grade,
    termStart: p.termStart, termEnd: p.termEnd, status: p.status,
    ...(p.deal ? { deal: p.deal } : {}), ...(p.openSig ? { openSig: p.openSig } : {}), ...(p.acceptSig ? { acceptSig: p.acceptSig } : {}),
    ...(p.premiumSig ? { premiumSig: p.premiumSig } : {}), ...(p.claimSig ? { claimSig: p.claimSig } : {}), ...(p.payoutSig ? { payoutSig: p.payoutSig } : {}),
    ...(p.refundSig ? { refundSig: p.refundSig } : {}), ...(p.challengeSig ? { challengeSig: p.challengeSig } : {}),
    ...(p.outage ? { outage: { detectedAt: p.outage.detectedAt, gapSecs: p.outage.gapSecs, ...(p.outage.peaqEventTx ? { peaqEventTx: p.outage.peaqEventTx } : {}), ...(p.outage.insurerCheck ? { insurerCheck: p.outage.insurerCheck } : {}), simulated: true as const } } : {}),
    ...(p.reason ? { reason: p.reason } : {}),
  }));
  const earned = jobs.done.reduce((s, j) => s + BigInt(j.amount), 0n);
  const spent = microOf(totals(history).usdc);
  return {
    v2: { configured: true, lastTick: lastTick ? { at: lastTick.at, steps: lastTick.steps } : null },
    network, scores, insurance: { policies: views },
    earnings: {
      jobs: jobs.done.length, earned: usdcExact(earned), spentOnEnergy: usdcExact(spent), net: usdcExact(earned - spent),
      recent: jobs.done.slice(0, 10).map((j) => ({ id: j.id, at: j.at, amount: usdcExact(BigInt(j.amount)), deal: j.deal ?? null, releaseSig: j.releaseSig ?? null, robotEventTx: j.robotEventTx ?? null })),
    },
  };
}
