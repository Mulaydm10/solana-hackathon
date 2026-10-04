// Starts the mission service on a long-running host (the Omen or the Mac) for the site's /api/missions routes.
//   MISSION_SERVICE_TOKEN   bearer token shared with the site's server env (>= 32 chars)          required
//   DEAL_VERIFIER           the marketplace verifier named on every agent deal                     required
//   BROKER_MASTER_KEY       64 hex; unseals provider credentials                                   required
//   BROKER_CREDENTIALS      path to a JSON array of sealed credentials (sealCredential output)     default: none
//   MISSION_FEE_PAYER       path to a keypair file with a little devnet SOL (pays agents' tx fees)  required
//   MISSION_TEAM_SELLER     path to the team seller's keypair (seller of the Team listings; demo:   optional
//                           surface/.keys/sellers/<id>.json): accepts fee deals, delivers the product  (no fee deals without it)
//   DEAL_RPC_URL / DEAL_MINT / HOST / PORT                                                          devnet, Circle USDC, 127.0.0.1, 3320
// Mainnet is refused. Workers are the deterministic ones in ../workers until PLAN §11.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, createKeyPairSignerFromBytes } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import type { DealClient, DealContext } from "@deal/chain";
import {
  createBroker, createMissionService, createVault, liveFrom, mandateSourceFromChain, masterKeyFromEnv, mockBooking, mockMarketData,
  type SealedCredential,
} from "../src/index.ts";

const env = process.env;
const fail = (m: string) => { console.error(`serve-missions: ${m}`); process.exit(1); };
const rpcUrl = env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
if (/mainnet/i.test(rpcUrl)) fail("mainnet is not supported");
const token = env.MISSION_SERVICE_TOKEN ?? "";
if (token.length < 32) fail("MISSION_SERVICE_TOKEN must be at least 32 characters");
const verifier = env.DEAL_VERIFIER ?? "";
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(verifier)) fail("DEAL_VERIFIER must be the marketplace verifier's address");

// Agents' spends are signed by the agents' own keys; this fee payer only pays the transaction fees.
if (!env.MISSION_FEE_PAYER) fail("MISSION_FEE_PAYER must point to a keypair file with a little devnet SOL");
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(env.MISSION_FEE_PAYER!, "utf8")) as number[]));
const client = createClient().use(signerPlugin(payer)).use(solanaRpc({ rpcUrl }));
const teamSeller = env.MISSION_TEAM_SELLER
  ? await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(env.MISSION_TEAM_SELLER, "utf8")) as number[]))
  : undefined;
const ctx: DealContext = { client: client as unknown as DealClient, mint: (env.DEAL_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") as never };
const master = masterKeyFromEnv(env);
const sealed: SealedCredential[] = env.BROKER_CREDENTIALS ? JSON.parse(readFileSync(env.BROKER_CREDENTIALS, "utf8")) : [];
const source = mandateSourceFromChain(ctx);
const broker = createBroker({ vault: createVault(master, sealed), providers: [mockMarketData, mockBooking], mandates: source });
const workers = Object.fromEntries(["researcher", "writer"].map((r) => [r, fileURLToPath(new URL(`../workers/${r}.mjs`, import.meta.url))]));

const svc = createMissionService({
  ctx, broker, capabilities: ["market:read", "booking:quote", "booking:pay"], workers, live: liveFrom(source),
  dealRules: { verifier: verifier as never }, token, team: teamSeller ? { seller: teamSeller } : undefined,
});
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3320);
svc.listen(port, host, () => console.log(`serve-missions: listening on http://${host}:${port} (fee payer ${payer.address}${teamSeller ? `, team seller ${teamSeller.address}` : ", no team seller: fee deals refused"})`));
