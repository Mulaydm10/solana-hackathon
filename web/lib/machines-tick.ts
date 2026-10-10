// POST /api/machines/tick (#253): the handler, with the runtime injected so it is testable without a network.
// Auth: Authorization: Bearer $MACHINE_TICK_SECRET, compared in constant time. The reply never carries a key or the secret.
import { timingSafeEqual } from "node:crypto";
import { parseEnv, requireEnv, type ServerEnv } from "./env";
import { robotTick, type RobotTickDeps } from "./machines";

const json = (body: unknown, status: number) => Response.json(body, { status });

export function secretMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want); // a different length is a mismatch without comparing
}

export async function handleTick(req: Request, raw: Record<string, string | undefined>, makeDeps: (env: ServerEnv) => Promise<RobotTickDeps>, nowSecs = Math.floor(Date.now() / 1000)): Promise<Response> {
  const env = requireEnv(parseEnv(raw), "machines");
  if (!env.ok) return json(env.body, env.status);
  const secret = env.env.MACHINE_TICK_SECRET;
  if (secret === undefined) return json({ ok: false, reason: "NOT_CONFIGURED", message: "the robot's tick is not configured on this deployment" }, 503);
  if (!secretMatches(req.headers.get("authorization"), secret)) return json({ ok: false, reason: "UNAUTHORIZED", message: "wrong or missing tick credentials" }, 401);
  try {
    const r = await robotTick(await makeDeps(env.env), nowSecs);
    return json({ ok: true, decision: r.decision, battery: { ...r.battery, simulated: true }, ...(r.duplicate ? { duplicate: true } : {}), ...(r.charge ? { charge: r.charge } : {}), ...(r.network !== undefined ? { network: r.network } : {}) }, 200);
  } catch (e) {
    console.error("[machines] tick failed:", e instanceof Error ? e.name : "error");
    return json({ ok: false, reason: "MACHINES_FAILED", message: "the robot's tick could not complete" }, 502);
  }
}
