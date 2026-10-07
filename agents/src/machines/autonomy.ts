// The robot decides for itself (#252). The battery and the driving are SIMULATED (a fixed drain per hour); the payment
// the decision leads to is real. Pure and deterministic: no clock, no network, never throws for normal inputs.
// Money is bigint micro-USDC in whole cents (peaq revenue events refuse a fraction of a cent); battery % may be a float.

export type RobotModel = { capacityKwh: number; drainPctPerHour: number; lowPct: number; targetPct: number; pricePerKwhMicro: bigint };
/** The simulated delivery robot. pricePerKwhMicro equals the pad's price (web lib/machines.ts MACHINE_LIMITS.pricePerKwh). */
export const DEFAULT_ROBOT: RobotModel = { capacityKwh: 2, drainPctPerHour: 12, lowPct: 25, targetPct: 80, pricePerKwhMicro: 320_000n };

export type Battery = { levelPct: number; updatedAt: number }; // unix seconds
export type MandateLeft = { perTxCap: bigint; cap: bigint; spent: bigint; live: boolean };
export type Decision =
  | { action: "wait"; reason: string }
  | { action: "charge"; kWh: string; amount: bigint; reason: string };

const CENT = 10_000n; // micro-USDC
const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
const pct = (n: number) => `${Math.round(n)}%`;

/** Drain since `updatedAt`, never below 0; time never moves backwards (an earlier `nowSecs` returns `b` unchanged). */
export function advance(b: Battery, nowSecs: number, m: RobotModel): Battery {
  if (!(nowSecs > b.updatedAt)) return b;
  const hours = (nowSecs - b.updatedAt) / 3600;
  return { levelPct: clampPct(b.levelPct - m.drainPctPerHour * hours), updatedAt: nowSecs };
}

/** Charge only when below `lowPct` and the mandate is live; the amount is capped here, in code, never by the program's refusal. */
export function decide(b: Battery, mandate: MandateLeft, m: RobotModel): Decision {
  const level = clampPct(b.levelPct);
  if (!mandate.live) return { action: "wait", reason: `battery ${pct(level)}: mandate is not live, cannot pay` };
  if (level >= m.lowPct) return { action: "wait", reason: `battery ${pct(level)}: no charge needed` };
  // kWh to reach the target, in milli-kWh (rounded down)
  const wantMilli = BigInt(Math.max(0, Math.floor(((m.targetPct - level) / 100) * m.capacityKwh * 1000 + 1e-9)));
  let amount = (wantMilli * m.pricePerKwhMicro) / 1000n;
  const left = mandate.cap - mandate.spent;
  const capped = amount > mandate.perTxCap || amount > left;
  if (amount > mandate.perTxCap) amount = mandate.perTxCap;
  if (amount > left) amount = left;
  amount -= amount % CENT; // whole cents, rounded down
  if (amount < CENT) return { action: "wait", reason: `battery ${pct(level)} < ${m.lowPct}%: mandate left allows less than 0.01 USDC` };
  // recompute kWh from the capped amount (rounded down) so kWh x price never exceeds the amount
  const milli = (amount * 1000n) / m.pricePerKwhMicro;
  if (milli <= 0n) return { action: "wait", reason: `battery ${pct(level)} < ${m.lowPct}%: nothing to buy at this price` };
  const kWh = fmtKwh(milli);
  const reason = capped
    ? `battery ${pct(level)} < ${m.lowPct}%: charging ${kWh} kWh (capped by the mandate)`
    : `battery ${pct(level)} < ${m.lowPct}%: charging ${kWh} kWh to reach ${m.targetPct}%`;
  return { action: "charge", kWh, amount, reason };
}

/** Battery after a delivered charge of `kWh` (a 3-decimal string, parsed exactly). */
export function afterCharge(b: Battery, kWh: string, nowSecs: number, m: RobotModel): Battery {
  const milli = parseKwhMilli(kWh);
  const add = milli === null ? 0 : (Number(milli) / 1000 / m.capacityKwh) * 100;
  return { levelPct: clampPct(b.levelPct + add), updatedAt: nowSecs };
}

function fmtKwh(milli: bigint): string {
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, "0")}`;
}
function parseKwhMilli(s: string): bigint | null {
  const x = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s.trim());
  return x ? BigInt(x[1]!) * 1000n + BigInt((x[2] ?? "").padEnd(3, "0")) : null;
}
