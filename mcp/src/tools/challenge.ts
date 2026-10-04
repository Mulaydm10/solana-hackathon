import { z } from "zod";
import { deals } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";
import { badInput, isAddress, needChain, needSigner } from "../access.ts";

export default defineTool({
  name: "challenge",
  description:
    "Dispute a delivered deal inside its review window (posting the bond). The deal's independent verifier decides; with no verdict in time you are refunded. Signs with this agent's own key (it must be the buyer).",
  input: { deal: z.string() },
  writes: true,
  async run(args, c) {
    if (!isAddress(args.deal)) return badInput("deal must be a deal address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const r = await deals.challenge(ch.value.ctx, s.value, args.deal as never);
    return r.ok ? ok({ signature: r.signature }) : r;
  },
});
