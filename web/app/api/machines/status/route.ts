// GET /api/machines/status -> the two simulated machines, the robot's rules (from chain), recent charges, totals.
import { parseEnv, requireEnv } from "../../../../lib/env";
import { machineStatus } from "../../../../lib/machines-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const env = requireEnv(parseEnv(process.env), "machines");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  try {
    return Response.json({ ok: true, ...(await machineStatus(env.env)) });
  } catch (e) {
    console.error("[machines] status failed:", e instanceof Error ? e.name : "error");
    return Response.json({ ok: false, reason: "MACHINES_FAILED", message: "machine status could not be read" }, { status: 502 });
  }
}
