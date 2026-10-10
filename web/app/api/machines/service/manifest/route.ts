// GET /api/machines/service/manifest -> the machine-readable description of Fiducia Insure (#283).
import { insureManifest } from "../../../../../lib/machines-insure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const payTo = process.env.FIDUCIA_INSURE_PAYEE;
  return Response.json(insureManifest(new URL(req.url).origin, payTo && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo) ? payTo : undefined), { headers: { "cache-control": "no-store" } });
}
