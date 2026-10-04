import { z } from "zod";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getListing } from "@deal/chain";
import { metaHash, validateListingMeta, type ServiceMeta } from "@deal/core";
import { payAndCall, SOLANA_DEVNET } from "@deal/agents";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, needSigner, plain, usdcToBase } from "../access.ts";

/**
 * One paid call to a Service listing over x402 (PLAN §5): only for an agent spending its own owner's money. What
 * may be paid is built from the ON-CHAIN listing (payee = its seller, mint = its mint, at most its price), never
 * from the 402 the endpoint sends, so a seller cannot raise its price or redirect the money. The endpoint comes
 * from the listing metadata, checked against the on-chain meta hash.
 */
export default defineTool({
  name: "call_service",
  description:
    "Call a Service listing once and pay per call (x402, USDC on devnet) from this agent's own wallet. Pays only the listing's on-chain seller, at most its on-chain price; no answer, no charge. Pass the listing's metadata (from the listing page) if the site does not serve it.",
  input: { listing: z.string(), body: z.record(z.string(), z.unknown()), max_price_usdc: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional() },
  writes: true,
  async run(args, c) {
    if (!isAddress(args.listing)) return badInput("listing must be a listing address.");
    const cap = args.max_price_usdc === undefined ? undefined : usdcToBase(args.max_price_usdc);
    if (cap === null) return badInput("max_price_usdc must be decimal USDC.");
    if (c.config.cluster !== "devnet") return refuse("UNSUPPORTED", "Per-call payments run on devnet only.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const l = await getListing(ch.value.ctx, args.listing as never);
    if (!l) return refuse("NOT_FOUND", "No listing at that address.");
    if (l.kind !== "Service") return refuse("NOT_A_SERVICE", "Only Service listings are called per use; buy data with buy.");
    if (!l.active || l.assessedAt === 0) return refuse("NOT_BUYABLE", "The listing is inactive or not attested by an assessor.");
    if (l.mint !== ch.value.ctx.mint) return refuse("MINT_MISMATCH", "The listing is priced in a different token than this server settles in.");

    let raw: unknown = args.meta;
    if (raw === undefined) {
      if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Pass meta, or set DEAL_SITE_URL so the listing's metadata can be fetched.");
      try {
        const r = await (c.fetch ?? fetch)(new URL(`/api/listings/${l.address}`, c.config.siteUrl), { headers: { accept: "application/json" } });
        if (r.status === 404) return refuse("NOT_CONFIGURED", "This site does not serve listing metadata yet; pass meta.");
        if (!r.ok) return refuse("SITE_ERROR", `The site answered ${r.status}.`);
        raw = ((await r.json()) as { meta?: unknown }).meta;
      } catch {
        return refuse("SITE_UNREACHABLE", "The marketplace site did not answer.");
      }
    }
    const meta = validateListingMeta(raw);
    if (!meta.ok || meta.value.kind !== "Service") return refuse("BAD_META", "The metadata is not a valid service description.");
    if (bytesToHex(metaHash(meta.value)) !== l.metaHash) return refuse("META_MISMATCH", "This metadata is not what the seller listed on chain.");

    const price = BigInt(l.price);
    const maxAmount = cap !== undefined && cap < price ? cap : price;
    const paid = await payAndCall(
      (meta.value as ServiceMeta).endpoint,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(args.body) },
      s.value,
      { network: SOLANA_DEVNET, asset: l.mint, payTo: l.seller, maxAmount },
      { rpcUrl: c.config.rpcUrl, fetch: c.fetch ? (u, i) => c.fetch!(u, i) : undefined },
    );
    if (!paid.ok) return refuse(paid.reason, paid.message);
    return ok(plain({ listing: l.address, status: paid.status, charged: paid.charged, transaction: paid.transaction ?? null, maxPaid: maxAmount, answer: paid.body }));
  },
});
