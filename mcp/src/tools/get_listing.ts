import { z } from "zod";
import { fetchMaybeAssessorRegistry, getListing, getSellerRep, registryAddress } from "@deal/chain";
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
    // Buyable means the program will accept it now: active, attested, and its assessor still registered.
    const reg = await fetchMaybeAssessorRegistry(ch.value.ctx.client.rpc as never, await registryAddress());
    const assessorRegistered = reg.exists && reg.data.assessors.includes(l.assessor as never);
    return ok(plain({
      ...l, attested: l.assessedAt > 0, assessorRegistered, buyable: l.active && l.assessedAt > 0 && assessorRegistered,
      reputation: { ...rep, score: score.score, flags: score.flags, summary: describeRep(score) },
    }));
  },
});
