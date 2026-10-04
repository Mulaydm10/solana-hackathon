// GET /api/missions/:mission -> status, plans and events from the mission service (#73).
import { parseEnv, requireEnv } from "../../../../lib/env";
import { missionService } from "../../../../lib/mission-service";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ mission: string }> }) {
  const env = requireEnv(parseEnv(process.env), "missions");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const { mission } = await ctx.params;
  if (!ADDRESS.test(mission)) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  const r = await missionService(env.env, `/missions/${mission}`);
  return Response.json(r.body, { status: r.status });
}
