// POST /api/demo/missions/:mission/approve { stage } -> the demo buyer approves that stage's plan, only on its own missions.
import { parseEnv, requireEnv } from "../../../../../../lib/env";
import { approveDemo, clientIp, guarded } from "../../../../../../lib/demo";
import { demoDeps } from "../../../../../../lib/demo-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ mission: string }> }) {
  const env = requireEnv(parseEnv(process.env), "demo");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const { mission } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { stage?: unknown };
  return guarded(async () => approveDemo(await demoDeps(env.env), clientIp(req), mission, body?.stage));
}
