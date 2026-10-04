import { z } from "zod";
import { getListing, getSellerRep } from "@deal/chain";
import { describeRep, repScore } from "@deal/core";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, plain } from "../access.ts";

/** One listing as the chain has it, with the seller's reputation scored (never the seller's own claims). */
export default defineTool({
  name: "get_listing",
  description:
    "Read one listing from the chain: kind, price, content hash, whether a registered assessor attested it, and the seller's on-chain reputation score. Use before buy.",
  input: { listing: z.string() },
  writes: false,
  async run(args, c) {
    if (!isAddress(args.listing)) return badInput("listing must be a listing address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const l = await getListing(ch.value.ctx, args.listing as never);
    if (!l) return refuse("NOT_FOUND", "No listing at that address.");
    const rep = await getSellerRep({ ...ch.value.ctx, mint: l.mint }, l.seller);
    const score = repScore(rep);
    return ok(plain({ ...l, attested: l.assessedAt > 0, buyable: l.active && l.assessedAt > 0, reputation: { ...rep, score: score.score, flags: score.flags, summary: describeRep(score) } }));
  },
});
