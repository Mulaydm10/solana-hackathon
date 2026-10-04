// POST /api/missions/:mission/start -> the service starts watching the chain for the buyer's approvals (#73).
// Nothing runs before the buyer's own on-chain approval of each stage, so starting early is harmless.
import { parseEnv, requireEnv } from "../../../../../lib/env";
import { missionService } from "../../../../../lib/mission-service";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(_req: Request, ctx: { params: Promise<{ mission: string }> }) {
  const env = requireEnv(parseEnv(process.env), "missions");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const { mission } = await ctx.params;
  if (!ADDRESS.test(mission)) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  const r = await missionService(env.env, `/missions/${mission}/start`, {});
  return Response.json(r.body, { status: r.status });
}
