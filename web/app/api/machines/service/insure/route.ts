// POST /api/machines/service/insure { machineId } -> a downtime-insurance quote, 0.01 USDC per call over x402 (Solana devnet) (#283).
import { insureRoute } from "../../../../../lib/machines-insure-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return insureRoute(req);
}
