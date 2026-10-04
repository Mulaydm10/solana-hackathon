import { z } from "zod";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress } from "../access.ts";

/** The seller's active listings as the site's catalogue shows them (grade, reputation, price). */
export default defineTool({
  name: "my_listings",
  description:
    "List this agent's own active listings on the marketplace (or another seller's, by address): price, assessor grade, attestation and reputation, as buyers see them.",
  input: { seller: z.string().optional() },
  writes: false,
  async run(args, c) {
    if (args.seller !== undefined && !isAddress(args.seller)) return badInput("seller must be a wallet address.");
    if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Set DEAL_SITE_URL to the marketplace site.");
    const seller = args.seller ?? (c.chain ? (await c.chain()).signer?.address : undefined);
    if (!seller) return refuse("NO_SIGNER", "Set DEAL_KEYPAIR, or name a seller address.");
    try {
      const u = new URL("/api/catalogue", c.config.siteUrl);
      u.searchParams.set("seller", seller);
      const r = await (c.fetch ?? fetch)(u, { headers: { accept: "application/json" } });
      if (!r.ok) return refuse("SITE_ERROR", `The site answered ${r.status}.`);
      const body = (await r.json()) as { listings?: { seller?: unknown }[] };
      // Filtered here as well: a site that ignores `seller` must not show someone else's listings as ours.
      const mine = (Array.isArray(body.listings) ? body.listings : []).filter((l) => l.seller === seller);
      return ok({ seller, listings: mine.slice(0, 50) });
    } catch {
      return refuse("SITE_UNREACHABLE", "The marketplace site did not answer.");
    }
  },
});
