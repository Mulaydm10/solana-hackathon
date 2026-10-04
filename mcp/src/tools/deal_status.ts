import { z } from "zod";
import { getDeal } from "@deal/chain";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, plain } from "../access.ts";

export default defineTool({
  name: "deal_status",
  description: "Read one escrow deal from the chain: status, amounts, deadlines, delivery hash. Use to follow a purchase before releasing or challenging.",
  input: { deal: z.string() },
  writes: false,
  async run(args, c) {
    if (!isAddress(args.deal)) return badInput("deal must be a deal address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const d = await getDeal(ch.value.ctx, args.deal as never);
    return d ? ok(plain(d)) : refuse("NOT_FOUND", "No deal at that address.");
  },
});
