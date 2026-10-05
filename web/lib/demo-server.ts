// Server-only wiring of the demo buyer (#183): the real chain, mission service and registry behind lib/demo.ts.
// The key is parsed here from the server env and never leaves this module except as a signer.
import { createClient, createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { fetchMaybeBuyerPolicy, fetchMaybeDeal, fetchMaybeDealLink, fetchMaybeMission, findLinkPda, policyAddress, STATUS_NAMES, type DealClient } from "@deal/chain";
import type { ServerEnv } from "./env";
import { missionService } from "./mission-service";
import { siteRegistry } from "./site-registry";
import { blueprintFor } from "./teams";
import { USDC_DEVNET } from "./registry";
import { createLimiter, type DemoDeps } from "./demo";

const limiter = createLimiter();
const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString("hex");
let cached: { key: string; deps: Promise<DemoDeps> } | undefined;

export function demoDeps(env: ServerEnv): Promise<DemoDeps> {
  if (cached && cached.key === env.DEMO_BUYER_KEY) return cached.deps;
  const deps = (async (): Promise<DemoDeps> => {
    const buyer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(env.DEMO_BUYER_KEY!) as number[]));
    const client = createClient().use(signerPlugin(buyer)).use(solanaRpc({ rpcUrl: env.rpcUrl })) as unknown as DealClient;
    const rpc = createSolanaRpc(env.rpcUrl);
    const mint = (env.DEAL_MINT ?? USDC_DEVNET) as Address;
    return {
      buyer, mint, limit: limiter, nowSecs: () => Math.floor(Date.now() / 1000),
      send: async (ixs) => (await client.sendTransaction(ixs)).context.signature,
      service: (path, body) => missionService(env, path, body),
      policy: async () => {
        const p = await fetchMaybeBuyerPolicy(rpc, await policyAddress(buyer.address));
        return p.exists ? { periodBudget: p.data.periodBudget, maxPrice: p.data.maxPrice } : null;
      },
      missionBuyer: async (mission) => {
        const m = await fetchMaybeMission(rpc, mission);
        return m.exists ? m.data.buyer : null;
      },
      feeDeal: async (deal) => {
        const d = await fetchMaybeDeal(rpc, deal);
        if (!d.exists) return null;
        const link = await fetchMaybeDealLink(rpc, (await findLinkPda({ deal }))[0]);
        return {
          deal, buyer: d.data.buyer, seller: d.data.seller, mint: d.data.mint, status: STATUS_NAMES[d.data.status] ?? "Unknown",
          deliveryHash: hex(d.data.deliveryHash), listing: link.exists ? link.data.listing : null,
        };
      },
      team: async () => {
        const t = (await siteRegistry().list()).find((l) => l.kind === "Team" && blueprintFor(l.contentHash));
        return t ? { listing: t.address, seller: t.seller, price: t.price, contentHash: t.contentHash, blueprint: blueprintFor(t.contentHash)! } : null;
      },
    };
  })();
  cached = { key: env.DEMO_BUYER_KEY!, deps };
  return deps;
}
