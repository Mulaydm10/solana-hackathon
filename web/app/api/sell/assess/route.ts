// POST /api/sell/assess { listing, contentHash?, report?, reportHash?, meta?, service? } (mcp publish_listing sends
// the first four): the marketplace assessor attests its OWN assessment; a report sent by the caller is ignored.
import { assessAndAttest } from "../../../../lib/sell";
import { badRequest, readJson, reply, sellEnv } from "../../../../lib/sell-route";
import { sellRuntime } from "../../../../lib/sell-server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const e = sellEnv();
  if (!e.ok) return e.res;
  const body = await readJson(req);
  if (!body) return badRequest();
  return reply(await assessAndAttest(await sellRuntime(e.env), body));
}
