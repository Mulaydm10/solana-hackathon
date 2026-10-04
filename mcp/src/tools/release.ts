import { z } from "zod";
import { deals } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";
import { badInput, hexToBytes, isAddress, isHex32, needChain, needSigner } from "../access.ts";

export default defineTool({
  name: "release",
  description:
    "Pay the seller for a delivered deal. You must name the delivery hash you checked: the program refuses if the seller delivered anything else. Signs with this agent's own key (it must be the buyer).",
  input: { deal: z.string(), delivery_hash: z.string() },
  writes: true,
  async run(args, c) {
    if (!isAddress(args.deal) || !isHex32(args.delivery_hash)) return badInput("deal must be an address and delivery_hash 64 hex characters.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const r = await deals.release(ch.value.ctx, s.value, args.deal as never, hexToBytes(args.delivery_hash));
    return r.ok ? ok({ signature: r.signature }) : r;
  },
});
