// POST /api/machines/charge { amount: "0.40" | "0.60" } -> the simulated robot pays the simulated pad on devnet
// (#229). 0.60 is over the robot's per-charge limit: simulated, refused by the program, never sent. Rate limited.
import { parseEnv, requireEnv } from "../../../../lib/env";
import { clientIp } from "../../../../lib/demo";
import { runMachineCharge } from "../../../../lib/machines";
import { machineRuntime } from "../../../../lib/machines-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const env = requireEnv(parseEnv(process.env), "machines");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const body = await req.json().catch(() => ({}));
  try {
    const r = await runMachineCharge((await machineRuntime(env.env)).deps, clientIp(req), body);
    return r.ok ? Response.json(r) : Response.json({ ok: false, reason: r.reason, message: r.message }, { status: r.status });
  } catch (e) {
    console.error("[machines] charge failed:", e instanceof Error ? e.name : "error");
    return Response.json({ ok: false, reason: "MACHINES_FAILED", message: "the charge could not complete; nothing more was signed" }, { status: 502 });
  }
}
