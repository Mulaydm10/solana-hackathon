import { z } from "zod";
import { getMission } from "@deal/chain";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, plain } from "../access.ts";

export default defineTool({
  name: "mission_status",
  description: "Read a hired team's mission from the chain: budget, spent, stages and which are approved, closed or not. Approving stages is for the human, in their wallet.",
  input: { mission: z.string() },
  writes: false,
  async run(args, c) {
    if (!isAddress(args.mission)) return badInput("mission must be a mission address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const m = await getMission(ch.value.ctx, args.mission as never);
    return m ? ok(plain(m)) : refuse("NOT_FOUND", "No mission at that address.");
  },
});
