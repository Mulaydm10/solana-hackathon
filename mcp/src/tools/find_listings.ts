import { z } from "zod";
import { defineTool, ok, refuse } from "../tool.ts";
import { usdcToBase } from "../access.ts";

/** Search the marketplace catalogue (the site ranks by verified fields: assessor grade, reputation). */
export default defineTool({
  name: "find_listings",
  description:
    "Search the marketplace for data, services and agent teams. Results are ranked by match, then verified reputation and price; grades come from registered assessors, never from sellers. Then call get_listing.",
  input: { query: z.string().max(200).optional(), kind: z.enum(["Data", "Service", "Team"]).optional(), max_price_usdc: z.string().optional() },
  writes: false,
  async run(args, c) {
    if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Set DEAL_SITE_URL to the marketplace site.");
    const u = new URL("/api/catalogue", c.config.siteUrl);
    if (typeof args.query === "string") u.searchParams.set("q", args.query.slice(0, 200));
    if (args.kind) u.searchParams.set("kind", args.kind);
    const max = args.max_price_usdc === undefined ? null : usdcToBase(args.max_price_usdc);
    if (max !== null) u.searchParams.set("maxPrice", max.toString());
    try {
      const r = await (c.fetch ?? fetch)(u, { headers: { accept: "application/json" } });
      if (!r.ok) return refuse("SITE_ERROR", `The site answered ${r.status}.`);
      const body = (await r.json()) as { listings?: unknown[] };
      return ok({ listings: Array.isArray(body.listings) ? body.listings.slice(0, 50) : [] });
    } catch {
      return refuse("SITE_UNREACHABLE", "The marketplace site did not answer.");
    }
  },
});
