// GET /api/catalogue?q&kind&category&maxPrice&minGrade&hideFlagged&attestedOnly&seller
// The registry as JSON for agents (MCP find_listings). Same search and ranking as the catalogue page.
import { parseQuery, search } from "../../../lib/catalogue";
import { catalogueItem } from "../../../lib/catalogue-json";
import { demand } from "../../../lib/demand";
import { RegistryUnavailable, registryMode, siteRegistry } from "../../../lib/site-registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = parseQuery(Object.fromEntries(url.searchParams));
  const seller = url.searchParams.get("seller");
  if (seller !== null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seller)) return Response.json({ ok: false, reason: "BAD_REQUEST" }, { status: 400 });
  let all;
  try {
    all = await siteRegistry().list();
  } catch (e) {
    if (!(e instanceof RegistryUnavailable)) throw e;
    return Response.json(
      { ok: false, reason: "REGISTRY_UNAVAILABLE", message: "The listing registry is temporarily unavailable. Try again in a few seconds." },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
    );
  }
  const results = search(all, query).filter((l) => seller === null || l.seller === seller);
  // A seller looking at its own listings is not unmet demand.
  if (results.length === 0 && seller === null) demand.record({ q: query.q, category: query.category, kind: query.kind, budget: query.maxPrice });
  return Response.json(
    { mode: registryMode(), count: results.length, listings: results.slice(0, 50).map((l) => catalogueItem(l, url.origin)) },
    { headers: { "cache-control": "no-store" } },
  );
}
