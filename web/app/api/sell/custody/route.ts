// POST /api/sell/custody { listing, seller, data } (also what mcp publish_listing calls): the marketplace custody
// takes a data listing's bytes only if their sha256 is the listing's on-chain content hash; the key stays sealed here.
import { acceptCustody } from "../../../../lib/sell";
import { badRequest, readJson, reply, sellEnv } from "../../../../lib/sell-route";
import { sellRuntime } from "../../../../lib/sell-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const e = sellEnv();
  if (!e.ok) return e.res;
  const body = await readJson(req);
  if (!body) return badRequest();
  return reply(await acceptCustody(await sellRuntime(e.env), body));
}
