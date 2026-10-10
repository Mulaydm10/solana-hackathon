// POST /api/machines/power { pad, online } -> the owner's simulated power switch (#273). Bearer $MACHINE_TICK_SECRET.
import { handlePower } from "../../../../lib/machines-power";
import { blobNetworkStore } from "../../../../lib/machines-network";
import { machineBlobs } from "../../../../lib/machines-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handlePower(req, process.env, (env) => blobNetworkStore(machineBlobs(env, process.env)));
}
