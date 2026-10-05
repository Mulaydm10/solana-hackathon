// POST /api/demo/missions { goal } -> the server's devnet demo buyer hires the demo team (#183). Capped, rate limited.
import { parseEnv, requireEnv } from "../../../../lib/env";
import { clientIp, guarded, startDemo } from "../../../../lib/demo";
import { demoDeps } from "../../../../lib/demo-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const env = requireEnv(parseEnv(process.env), "demo");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const body = (await req.json().catch(() => ({}))) as { goal?: unknown };
  return guarded(async () => startDemo(await demoDeps(env.env), clientIp(req), body?.goal));
}
