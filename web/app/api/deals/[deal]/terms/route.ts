// POST /api/deals/[deal]/terms { terms }: keeps the canonical terms a deal committed to (only if they hash to the
// on-chain terms hash), so the verifier can read what the buyer approved (#108).
import { parseEnv } from "../../../../../lib/env";
import { storeTerms } from "../../../../../lib/deal-key";
import { dealDeps } from "../../../../../lib/deal-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ deal: string }> }) {
  const env = parseEnv(process.env);
  if (!env.ok) return Response.json({ ok: false, reason: env.reason, message: env.message }, { status: 500 });
  const body = (await req.json().catch(() => null)) as { terms?: unknown } | null;
  const r = await storeTerms(dealDeps(env.env), (await params).deal, body?.terms);
  return Response.json(r, { status: r.ok ? 200 : r.reason === "NO_DEAL" ? 404 : 400 });
}
