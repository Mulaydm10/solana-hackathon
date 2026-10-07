// What /machines shows (#229), shared by the page and GET /api/machines/status. Everything is read (chain, peaq,
// storage), never hard-coded; MCR is shown only as the API reports it. Server only; nothing here is a secret.
import type { ServerEnv } from "./env";
import { displayBattery, totals, usdc, type ChargeView, type RobotDecision } from "./machines";
import { machineRuntime, robotRules } from "./machines-server";

export type MachineCard = { role: "robot" | "pad"; name: string; machineId: string; wallet: string; mcr: { status: string; score?: number } | { unavailable: string } };
export type MachineStatus = {
  deployment: string;
  explorerTx: string | null;
  mission: string;
  machines: MachineCard[];
  rules: { cap: string; perTxCap: string; spent: string; payees: string[]; expiresAt: number; revoked: boolean; live: boolean } | null;
  history: ChargeView[];
  totals: ReturnType<typeof totals>;
  /** Simulated: advanced to now for display, never stored. */
  battery: ReturnType<typeof displayBattery>;
  decisions: RobotDecision[];
};

export async function machineStatus(env: ServerEnv, nowSecs = Math.floor(Date.now() / 1000)): Promise<MachineStatus> {
  const rt = await machineRuntime(env);
  const [rules, history, stored, decisions, robotMcr, padMcr] = await Promise.all([
    robotRules(rt).catch(() => null), rt.history.list(), rt.battery.get(), rt.decisions.list(), rt.peaq.queryMcr(rt.robotMachineId), rt.peaq.queryMcr(rt.padMachineId),
  ]);
  const mcr = (r: typeof robotMcr): MachineCard["mcr"] => (r.ok ? { status: r.status, ...(r.score !== undefined ? { score: r.score } : {}) } : { unavailable: r.message });
  return {
    deployment: rt.deployment,
    explorerTx: rt.explorerTx ?? null,
    mission: rt.mission,
    machines: [
      { role: "robot", name: "Delivery robot", machineId: rt.robotMachineId.toString(), wallet: rt.robot, mcr: mcr(robotMcr) },
      { role: "pad", name: "Charging pad", machineId: rt.padMachineId.toString(), wallet: rt.pad, mcr: mcr(padMcr) },
    ],
    rules: rules && {
      cap: usdc(BigInt(rules.cap)), perTxCap: usdc(BigInt(rules.perTxCap)), spent: usdc(BigInt(rules.spent)), payees: rules.payees.map(String),
      expiresAt: rules.expiresAt, revoked: rules.revoked, live: !rules.revoked && rules.expiresAt > nowSecs,
    },
    history,
    totals: totals(history),
    battery: displayBattery(stored, nowSecs),
    decisions: decisions.slice(0, 10),
  };
}
