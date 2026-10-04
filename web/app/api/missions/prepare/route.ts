// POST /api/missions/prepare { team, goal, budget, buyer } -> what the buyer's wallet signs (#73).
// The team is a Team listing address; its blueprint comes from the site, never from the request.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseEnv, requireEnv } from "../../../../lib/env";
import { missionService } from "../../../../lib/mission-service";
import { siteRegistry } from "../../../../lib/site-registry";
import { blueprintFor, toWire } from "../../../../lib/teams";

const Body = z.object({
  team: z.string().min(32).max(44),
  goal: z.string().min(3).max(2_000),
  /** Token base units as a decimal string. */
  budget: z.string().regex(/^\d{1,15}$/),
  buyer: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
});

export async function POST(req: Request) {
  const env = requireEnv(parseEnv(process.env), "missions");
  if (!env.ok) return Response.json(env.body, { status: env.status });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  // The blueprint is the one the Team listing commits to on chain (its content hash), never one named by the request.
  const listing = await siteRegistry().get(parsed.data.team);
  const bp = listing && listing.kind === "Team" ? blueprintFor(listing.contentHash) : undefined;
  if (!bp) return Response.json({ ok: false, reason: "UNKNOWN_TEAM" }, { status: 404 });
  const missionId = BigInt(`0x${randomBytes(6).toString("hex")}`).toString();
  const expiresAt = String(Math.floor(Date.now() / 1000) + Math.min(bp.maxDuration, 30 * 86_400 - 60));
  const r = await missionService(env.env, "/missions/prepare", {
    blueprint: toWire(bp), goal: parsed.data.goal, budget: parsed.data.budget, missionId, buyer: parsed.data.buyer, expiresAt,
  });
  return Response.json(r.body, { status: r.status });
}
