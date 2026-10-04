// Server-only helpers shared by the /api/sell/* routes: the "sell" capability gate and a size-capped JSON body.
import { parseEnv, requireEnv, type ServerEnv } from "./env";
import type { Reply } from "./sell";

/** Data uploads are at most 10 MB, base64 adds a third, and the rest of the body is small. */
const MAX_BODY = 14 * 1024 * 1024;

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sellEnv(): { ok: true; env: ServerEnv } | { ok: false; res: Response } {
  const e = requireEnv(parseEnv(process.env), "sell");
  return e.ok ? { ok: true, env: e.env } : { ok: false, res: Response.json(e.body, { status: e.status }) };
}

export const reply = (r: Reply) => Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
export const badRequest = () => Response.json({ ok: false, reason: "BAD_REQUEST", message: "send a JSON object (data at most 10 MB)" }, { status: 400 });
