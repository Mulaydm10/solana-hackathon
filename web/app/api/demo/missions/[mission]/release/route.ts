// POST /api/demo/missions/:mission/release { feeDeal } -> the demo buyer pays its team for exactly the delivered product.
import { parseEnv, requireEnv } from "../../../../../../lib/env";
import { clientIp, guarded, releaseDemo } from "../../../../../../lib/demo";
import { demoDeps } from "../../../../../../lib/demo-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ mission: string }> }) {
  const env = requireEnv(parseEnv(process.env), "demo");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const { mission } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { feeDeal?: unknown };
  return guarded(async () => releaseDemo(await demoDeps(env.env), clientIp(req), mission, body?.feeDeal));
}
