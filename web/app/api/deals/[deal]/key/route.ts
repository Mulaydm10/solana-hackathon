// POST /api/deals/[deal]/key { buyer, ephemeralPub, expires, signature }: key pickup for a browser buyer (#111, #125).
// Answers the data key sealed to the buyer's one-time key, plus the ciphertext; the browser opens and checks it.
import { parseEnv, requireEnv } from "../../../../../lib/env";
import { pickupKey } from "../../../../../lib/deal-key";
import { dealDeps } from "../../../../../lib/deal-server";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = { BAD_DEAL: 400, BAD_REQUEST: 400, NO_DEAL: 404, NO_LISTING: 404, NO_KEY: 404, NO_DATA: 404 };

export async function POST(req: Request, { params }: { params: Promise<{ deal: string }> }) {
  const e = requireEnv(parseEnv(process.env), "sell");
  if (!e.ok) return Response.json(e.body, { status: e.status });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ ok: false, reason: "BAD_REQUEST", message: "send JSON" }, { status: 400 });
  const r = await pickupKey(dealDeps(e.env), (await params).deal, body);
  return Response.json(r, { status: r.ok ? 200 : (STATUS[r.reason] ?? 403), headers: { "cache-control": "no-store" } });
}
