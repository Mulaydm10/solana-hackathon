// POST /api/sell/assess { listing, contentHash?, report?, reportHash?, meta?, service? } (mcp publish_listing sends
// the first four): the marketplace assessor attests its OWN assessment; a report sent by the caller is ignored.
import { assessAndAttest, attestLimiter } from "../../../../lib/sell";
import { badRequest, readJson, reply, sellEnv } from "../../../../lib/sell-route";
import { sellRuntime } from "../../../../lib/sell-server";

export const dynamic = "force-dynamic";

// The assessor signs and pays each attest tx for an anonymous caller: bounded per listing and per client (#136).
const limit = attestLimiter();

export async function POST(req: Request) {
  const e = sellEnv();
  if (!e.ok) return e.res;
  const body = await readJson(req);
  if (!body) return badRequest();
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const allowAttest = (listing: string, reattest: boolean) => limit(listing, client, reattest);
  return reply(await assessAndAttest({ ...(await sellRuntime(e.env)), allowAttest }, body));
}
