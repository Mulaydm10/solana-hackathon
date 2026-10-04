// POST /api/missions/:mission/start { feeDeal? } -> the service starts watching the chain for the buyer's approvals
// (#73). Nothing runs before the buyer's own on-chain approval of each stage, so starting early is harmless. The fee
// deal (opened by the buyer's wallet with the mission) is passed on so the team can deliver its final product there.
import { parseEnv, requireEnv } from "../../../../../lib/env";
import { missionService } from "../../../../../lib/mission-service";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(req: Request, ctx: { params: Promise<{ mission: string }> }) {
  const env = requireEnv(parseEnv(process.env), "missions");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const { mission } = await ctx.params;
  if (!ADDRESS.test(mission)) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { feeDeal?: unknown };
  if (body?.feeDeal !== undefined && (typeof body.feeDeal !== "string" || !ADDRESS.test(body.feeDeal))) {
    return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  }
  const r = await missionService(env.env, `/missions/${mission}/start`, body?.feeDeal ? { feeDeal: body.feeDeal } : {});
  return Response.json(r.body, { status: r.status });
}
