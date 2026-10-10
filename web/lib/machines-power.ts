// POST /api/machines/power (#273): the owner's simulated power switch for a pad. A pad that is off stops signing
// heartbeats (the outage it causes is simulated). Never public: same Bearer secret as the tick, compared in constant time.
import { parseEnv, requireEnv, type ServerEnv } from "./env";
import { secretMatches } from "./machines-tick";
import { parseNetworkEnv, setPadPower, type NetworkStore } from "./machines-network";

const json = (body: unknown, status: number) => Response.json(body, { status });

export async function handlePower(req: Request, raw: Record<string, string | undefined>, makeStore: (env: ServerEnv) => NetworkStore): Promise<Response> {
  const env = requireEnv(parseEnv(raw), "machines");
  if (!env.ok) return json(env.body, env.status);
  const secret = env.env.MACHINE_TICK_SECRET;
  if (secret === undefined) return json({ ok: false, reason: "NOT_CONFIGURED", message: "the power switch is not configured on this deployment" }, 503);
  if (!secretMatches(req.headers.get("authorization"), secret)) return json({ ok: false, reason: "UNAUTHORIZED", message: "wrong or missing credentials" }, 401);
  const net = parseNetworkEnv(raw);
  if (!net.ok) return json({ ok: false, reason: "NOT_CONFIGURED", message: "the pad network is not configured on this deployment", missing: net.missing }, 503);
  const body = await req.json().catch(() => ({}));
  try {
    const r = await setPadPower(makeStore(env.env), net.cfg, body);
    return r.ok ? json(r, 200) : json({ ok: false, reason: r.reason, message: r.message }, r.status);
  } catch (e) {
    console.error("[machines] power failed:", e instanceof Error ? e.name : "error");
    return json({ ok: false, reason: "MACHINES_FAILED", message: "the power switch could not be set" }, 502);
  }
}
