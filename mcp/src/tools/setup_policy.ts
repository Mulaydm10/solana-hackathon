import { z } from "zod";
import { deals } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";
import { badInput, needChain, needSigner, usdcToBase } from "../access.ts";

/** Once per agent wallet: the spending policy every purchase is checked against on chain. */
export default defineTool({
  name: "setup_policy",
  description:
    "Create this agent's on-chain spending policy (once): a daily budget and a maximum price per purchase, in USDC. Every later purchase is checked against it by the program, not by this server.",
  input: { daily_budget_usdc: z.string(), max_price_usdc: z.string() },
  writes: true,
  async run(args, c) {
    const budget = usdcToBase(args.daily_budget_usdc);
    const max = usdcToBase(args.max_price_usdc);
    if (budget === null || max === null || max > budget || budget === 0n) return badInput("Give daily_budget_usdc and max_price_usdc as decimal USDC, max <= budget.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const r = await deals.initPolicy(ch.value.ctx, s.value, {
      periodSecs: 86_400, periodBudget: budget, maxPrice: max, approvalThreshold: 10n ** 15n, approver: s.value.address,
      allowAnySeller: true, allowedSellers: [],
    });
    return r.ok ? ok({ signature: r.signature, dailyBudget: budget.toString(), maxPrice: max.toString() }) : r;
  },
});
