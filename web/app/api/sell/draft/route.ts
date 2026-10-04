// POST /api/sell/draft { seller, name, description, category, tags?, task?, price?, data? (base64) | service? }
// The seller chain step by step on the server (classify, assess, price, draft) and the create_listing parameters
// the seller's wallet then signs. Nothing is stored and nothing is signed here.
import type { Address } from "@solana/kit";
import { search } from "../../../../lib/catalogue";
import { draftListing, type DraftInput } from "../../../../lib/sell";
import { badRequest, readJson, reply, sellEnv } from "../../../../lib/sell-route";
import { sellRuntime } from "../../../../lib/sell-server";
import { siteRegistry } from "../../../../lib/site-registry";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const e = sellEnv();
  if (!e.ok) return e.res;
  const body = await readJson(req);
  if (!body) return badRequest();
  const rt = await sellRuntime(e.env);
  return reply(await draftListing({
    assessor: rt.assessor.address as Address,
    now: rt.now,
    probe: rt.probe,
    // Asking prices of the same kind on this site; the seller's own never count (core pricing).
    comparables: async (kind) => search(await siteRegistry().list(), { kind }).map((l) => ({ kind, price: l.price, sold: false, seller: l.seller })),
  }, body as unknown as DraftInput));
}
