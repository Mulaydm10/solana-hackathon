// POST /api/machines/tick -> the robot decides, and charges itself if it must (#253). Driven by the mission service's
// ticker (#257), not a Vercel Cron. Bearer $MACHINE_TICK_SECRET. One decision per 30-minute slot, at most one charge.
import { handleTick } from "../../../../lib/machines-tick";
import { machineRuntime, tickDeps } from "../../../../lib/machines-server";
import { withNetwork } from "../../../../lib/machines-network-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  return handleTick(req, process.env, async (env) => { const rt = await machineRuntime(env); return withNetwork(tickDeps(rt, env), rt, env); });
}
