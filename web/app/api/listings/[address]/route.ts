// GET /api/listings/:address: one listing from the registry, with its metadata (MCP call_service checks it
// against the on-chain meta_hash itself, so this route is a convenience, never the trust anchor).
import { siteRegistry } from "../../../../lib/site-registry";

export const dynamic = "force-dynamic";

// Letters and digits only (no path tricks); the registry decides whether such a listing exists.
const ADDRESS = /^[1-9A-Za-z]{32,44}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!ADDRESS.test(address)) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  const l = await siteRegistry().get(address);
  if (!l) return Response.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  const plain = JSON.parse(JSON.stringify(l, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return Response.json({ ok: true, ...plain }, { headers: { "cache-control": "no-store" } });
}
