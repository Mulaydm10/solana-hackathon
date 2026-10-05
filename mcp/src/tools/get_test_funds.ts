import { defineTool, ok, refuse } from "../tool.ts";
import { needChain, needSigner } from "../access.ts";

/**
 * Devnet only: test funds for the agent's own wallet, so a fresh agent can be demoed end to end. SOL for fees
 * comes from the cluster's airdrop, test USDC from the marketplace faucet (rate-limited by the site). Signs nothing.
 */
export default defineTool({
  name: "get_test_funds",
  description:
    "Devnet only: request test funds for this agent's own wallet: devnet SOL for fees (cluster airdrop) and test USDC from the marketplace faucet (once per wallet per 24 h). Signs nothing and costs nothing. Refused on any other cluster.",
  input: {},
  writes: true,
  async run(_args, c) {
    if (c.config.cluster !== "devnet") return refuse("UNSUPPORTED", "Test funds exist on devnet only.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const wallet = s.value.address;

    // Airdrop failures are common on the public devnet RPC (rate limits); report them, never throw.
    let sol: Record<string, unknown>;
    try {
      const rpc = ch.value.ctx.client.rpc as unknown as { requestAirdrop(a: string, l: bigint): { send(): Promise<string> } };
      sol = { ok: true, amount: "1", signature: await rpc.requestAirdrop(wallet, 1_000_000_000n).send() };
    } catch {
      sol = { ok: false, reason: "AIRDROP_FAILED", message: "The devnet airdrop was refused (rate limit); use https://faucet.solana.com for this address." };
    }

    let usdc: Record<string, unknown>;
    if (!c.config.siteUrl) usdc = { ok: false, reason: "NOT_CONFIGURED", message: "Set DEAL_SITE_URL to use the marketplace faucet." };
    else {
      try {
        const r = await (c.fetch ?? fetch)(new URL("/api/faucet", c.config.siteUrl), {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ wallet }),
        });
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        usdc = r.ok ? { ok: true, amount: typeof body.amount === "string" ? (Number(body.amount) / 1e6).toString() : null, signature: body.signature ?? null }
          : { ok: false, reason: typeof body.reason === "string" ? body.reason : "SITE_ERROR", message: typeof body.message === "string" ? body.message : `The site answered ${r.status}.` };
      } catch {
        usdc = { ok: false, reason: "SITE_UNREACHABLE", message: "The marketplace site did not answer." };
      }
    }
    if (!sol.ok && !usdc.ok) return refuse("NO_FUNDS", `SOL: ${String(sol.message)} USDC: ${String(usdc.message)}`);
    return ok({ wallet, sol, usdc, next: "my_wallet" });
  },
});
