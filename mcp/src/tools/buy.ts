import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { deals, getListing } from "@deal/chain";
import { canonicalize } from "@deal/core";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, chainNow, hexToBytes, isAddress, needChain, needSigner } from "../access.ts";

/** Buys from a listing under escrow: the program checks the listing, the content and the agent's own policy. */
export default defineTool({
  name: "buy",
  description:
    "Buy from a listing under escrow at its listed price. The money stays in escrow until you release it (or the review window passes); for data, delivery must be exactly the assessed content. Signs with this agent's own key.",
  input: { listing: z.string(), delivery_hours: z.number().int().min(1).max(720).optional() },
  writes: true,
  async run(args, c) {
    if (!isAddress(args.listing)) return badInput("listing must be a listing address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const l = await getListing(ch.value.ctx, args.listing as never);
    if (!l) return refuse("NOT_FOUND", "No listing at that address.");
    if (!l.active || l.assessedAt === 0) return refuse("NOT_BUYABLE", "The listing is inactive or not attested by a registered assessor.");
    if (l.mint !== ch.value.ctx.mint) return refuse("MINT_MISMATCH", "The listing is priced in a different token than this server settles in.");
    const nowSecs = await chainNow(ch.value);
    const verifier = c.config.verifier ?? undefined;
    const dealId = BigInt(nowSecs) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const terms = canonicalize({ listing: l.address, seller: l.seller, price: l.price, contentHash: l.contentHash, kind: l.kind });
    const r = await deals.open(ch.value.ctx, s.value, {
      seller: l.seller, dealId, amount: BigInt(l.price), deadline: nowSecs + (args.delivery_hours ?? 24) * 3600, reviewSecs: 600, resolveSecs: 600,
      toleranceBps: 0, stakeRequired: 0n, bondBps: verifier ? 1000 : 0, verifier: verifier as never, termsHash: sha256(new TextEncoder().encode(terms)),
      listing: l.address, listingContentHash: hexToBytes(l.contentHash),
    });
    return r.ok ? ok({ deal: r.deal, signature: r.signature, price: l.price, challengeable: Boolean(verifier) }) : r;
  },
});
