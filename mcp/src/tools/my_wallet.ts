import { findAssociatedTokenPda, fetchMaybeToken, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeBuyerPolicy, policyAddress } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";
import { needChain, needSigner } from "../access.ts";

/** The agent's own wallet as the chain sees it: what it can pay fees with, spend, and under which policy. */
export default defineTool({
  name: "my_wallet",
  description:
    "Show this agent's own wallet: its address, SOL for fees, the settlement token (USDC) it holds, and its on-chain spending policy if one exists. Call this first; if funds are missing on devnet, call get_test_funds; if there is no policy, call setup_policy before buy.",
  input: {},
  writes: false,
  async run(_args, c) {
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const { ctx } = ch.value;
    const owner = s.value.address;
    const rpc = ctx.client.rpc as never;
    const lamports = (await (ctx.client.rpc as unknown as { getBalance(a: string): { send(): Promise<{ value: bigint }> } }).getBalance(owner).send()).value;
    const [ata] = await findAssociatedTokenPda({ owner, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const token = await fetchMaybeToken(rpc, ata);
    const policy = await fetchMaybeBuyerPolicy(rpc, await policyAddress(owner));
    return ok({
      address: owner,
      cluster: c.config.cluster,
      sol: (Number(lamports) / 1e9).toString(),
      mint: ctx.mint,
      usdc: token.exists ? (Number(token.data.amount) / 1e6).toString() : "0",
      policy: policy.exists
        ? {
            dailyBudget: policy.data.periodBudget.toString(), spentThisPeriod: policy.data.periodSpent.toString(), maxPrice: policy.data.maxPrice.toString(),
            anySeller: policy.data.allowAnySeller, allowedSellers: policy.data.allowedSellers,
          }
        : null,
      next: lamports === 0n || !token.exists ? "get_test_funds" : policy.exists ? "find_listings" : "setup_policy",
    });
  },
});
