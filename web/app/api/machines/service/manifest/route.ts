// GET /api/machines/service/manifest -> the machine-readable description of Fiducia Insure (#283).
import { insureManifest } from "../../../../../lib/machines-insure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const b58 = (v: string | undefined) => (v && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : undefined);
  // the same mint the 402 asks for (machines-insure-server.ts insureConfig: DEAL_MINT, else devnet USDC)
  return Response.json(insureManifest(new URL(req.url).origin, b58(process.env.FIDUCIA_INSURE_PAYEE), b58(process.env.DEAL_MINT)), { headers: { "cache-control": "no-store" } });
}
