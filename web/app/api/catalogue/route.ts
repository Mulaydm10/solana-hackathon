// GET /api/catalogue?q&kind&category&maxPrice&minGrade&hideFlagged&attestedOnly
// The registry as JSON for agents (MCP find_listings). Same search and ranking as the catalogue page.
import { parseQuery, search } from "../../../lib/catalogue";
import { catalogueItem } from "../../../lib/catalogue-json";
import { demand } from "../../../lib/demand";
import { registryMode, siteRegistry } from "../../../lib/site-registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = parseQuery(Object.fromEntries(url.searchParams));
  const results = search(await siteRegistry().list(), query);
  if (results.length === 0) demand.record({ q: query.q, category: query.category, kind: query.kind, budget: query.maxPrice });
  return Response.json(
    { mode: registryMode(), count: results.length, listings: results.slice(0, 50).map((l) => catalogueItem(l, url.origin)) },
    { headers: { "cache-control": "no-store" } },
  );
}
