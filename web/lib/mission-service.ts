// Server-only client for the mission service (agents runtime, #70). The token and URL come from the server env;
// browsers only ever talk to this site's /api/missions routes.
import type { ServerEnv } from "./env";

export type ServiceReply = { status: number; body: unknown };

export async function missionService(env: ServerEnv, path: string, body?: unknown, timeoutMs = 15_000): Promise<ServiceReply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(new URL(path, env.MISSION_SERVICE_URL), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${env.MISSION_SERVICE_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
    return { status: r.status, body: await r.json().catch(() => ({ ok: false, reason: "BAD_REPLY" })) };
  } catch {
    return { status: 502, body: { ok: false, reason: "SERVICE_UNREACHABLE", message: "the mission service did not answer" } };
  } finally {
    clearTimeout(timer);
  }
}
