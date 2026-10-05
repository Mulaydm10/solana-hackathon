// Starts the mission service on a long-running host (the Omen or the Mac) for the site's /api/missions routes.
//   MISSION_SERVICE_TOKEN   bearer token shared with the site's server env (>= 32 chars)          required
//   DEAL_VERIFIER           the marketplace verifier named on every agent deal                     required
//   BROKER_MASTER_KEY       64 hex; unseals provider credentials                                   required
//   BROKER_CREDENTIALS      path to a JSON array of sealed credentials (sealCredential output)     default: placeholders for the mocks
//   MISSION_FEE_PAYER       path to a keypair file with a little devnet SOL (pays agents' tx fees)  required
//   MISSION_TEAM_SELLER     path to the team seller's keypair (seller of the Team listings; demo:   optional
//                           surface/.keys/sellers/<id>.json): accepts fee deals, delivers the product  (no fee deals without it)
//   AI_PROVIDER             simulated = the labelled Simulated AI demo (no key); anthropic = Claude    default: Claude if
//                           (needs the key); unset = Claude with a key, else deterministic workers      a key is set
//   ANTHROPIC_API_KEY       the model key for the `llm:complete` provider (Claude workers, PLAN §11)  optional
//                           sealed into the broker vault at start and removed from this process's env; without it
//                           the workers produce their deterministic output (roles may still list llm:complete)
//   LLM_MODEL               model id for the workers                                                   default: claude-opus-5-5
//   MISSION_STORE           directory for each mission's public view (no keys), so the site still shows   default: ./demo-runs/missions
//                           missions after a restart, and scripted demo runs (demo:mission) appear too
//   DEMO_BUYERS             the site's demo buyer address(es), comma-separated: their missions show one   default: none
//                           over-cap payment refused on chain before the in-mandate one (#214)
//   MISSION_POLL_MS         how often the stage loop and the runner read the chain (ms)              default: 5000
//   DEAL_RPC_URL / DEAL_MINT / HOST / PORT                                                          devnet, Circle USDC, 127.0.0.1, 3320
// Mainnet is refused. Workers in ../workers use Claude through the broker when the key is set.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, createKeyPairSignerFromBytes } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import type { DealClient, DealContext } from "@deal/chain";
import {
  aiProviderFrom, createBroker, createMissionService, fileMissionStore, createVault, liveFrom, mandateSourceFromChain, masterKeyFromEnv, mockBooking, mockMarketData, sealCredential,
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
// The providers are mocks with no real account, but the broker still refuses a call without a credential
// (NO_CREDENTIAL), so each mock without a sealed one gets a placeholder sealed under this master key.
for (const p of ["market", "booking"]) if (!sealed.some((c) => c.provider === p)) sealed.push(sealCredential(master, p, `mock-${p}-placeholder`));
// The model key becomes a sealed broker credential like any other; nothing else in this process keeps it.
const ai = aiProviderFrom(env);
delete env.ANTHROPIC_API_KEY;
if (!ai.ok) fail(ai.message);
const choice = ai.ok ? ai.value : (undefined as never);
if (choice.credential && !sealed.some((c) => c.provider === "llm")) sealed.push(sealCredential(master, "llm", choice.credential));
const source = mandateSourceFromChain(ctx);
const broker = createBroker({ vault: createVault(master, sealed), providers: [mockMarketData, mockBooking, ...(choice.provider ? [choice.provider] : [])], mandates: source });
const workers = Object.fromEntries(["researcher", "writer"].map((r) => [r, fileURLToPath(new URL(`../workers/${r}.mjs`, import.meta.url))]));

// The public devnet RPC rate-limits; 5 s polling is what the recorded CLI demo uses (#222).
const pollMs = /^\d+$/.test(env.MISSION_POLL_MS ?? "") ? Math.max(1_000, Number(env.MISSION_POLL_MS)) : 5_000;
const svc = createMissionService({
  pollMs, runner: { pollMs },
  ctx, broker, capabilities: ["market:read", "booking:quote", "booking:pay", "llm:complete"], workers, live: liveFrom(source),
  aiProvider: choice.mode, dealRules: { verifier: verifier as never }, token, team: teamSeller ? { seller: teamSeller } : undefined,
  demoBuyers: (env.DEMO_BUYERS ?? "").split(",").map((a) => a.trim()).filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)),
  store: fileMissionStore(env.MISSION_STORE ?? fileURLToPath(new URL("../demo-runs/missions", import.meta.url))),
});
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3320);
svc.listen(port, host, () => console.log(`serve-missions: listening on http://${host}:${port} (fee payer ${payer.address}${teamSeller ? `, team seller ${teamSeller.address}` : ", no team seller: fee deals refused"}, ${choice.label})`));
