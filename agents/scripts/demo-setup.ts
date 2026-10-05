// Setup checks for demo:mission on devnet, run before any transaction is sent, so the demo can be run from another
// machine with nothing but env vars: every problem is one line naming the variable and how to fix it, all at once.
// Nothing here ever prints a key: keypair files are checked for shape only, RPC URLs are shown without query string
// or credentials (provider API keys often live there).
import { existsSync, readFileSync, statSync } from "node:fs";

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL = 1_000_000_000n;
export const MIN_LAMPORTS = SOL / 20n; // 0.05 SOL: mission + mandates + token accounts + fees, with margin

export type DemoEnv = { rpcUrl: string; buyerPath: string; buyerPathFromEnv: boolean; mint: string; verifier: string | null; store: string };
export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** The RPC URL as it may be printed: scheme, host and path only. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search || u.username ? " (query/credentials hidden)" : ""}`;
  } catch {
    return "(not a URL)";
  }
}

/** Reads and validates the demo's env vars. `defaults` are the script's own paths. */
export function demoEnv(env: Record<string, string | undefined>, defaults: { buyerPath: string; store: string }): Checked<DemoEnv> {
  const errors: string[] = [];
  const v = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const rpcUrl = v("DEAL_RPC_URL") ?? DEVNET_RPC;
  let url: URL | null = null;
  try { url = new URL(rpcUrl); } catch { /* reported below */ }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    errors.push(`DEAL_RPC_URL is not an http(s) URL. Set it to a Solana devnet RPC, e.g. DEAL_RPC_URL=${DEVNET_RPC}`);
  } else if (/mainnet/i.test(url.host + url.pathname)) {
    errors.push(`DEAL_RPC_URL points at mainnet (${safeUrl(rpcUrl)}). This demo runs on devnet only, e.g. DEAL_RPC_URL=${DEVNET_RPC}`);
  }
  const mint = v("DEAL_MINT") ?? DEVNET_USDC;
  if (!ADDRESS.test(mint)) errors.push(`DEAL_MINT is not a Solana address. Leave it unset for Circle's devnet USDC (${DEVNET_USDC}).`);
  const verifier = v("DEAL_VERIFIER") ?? null;
  if (verifier !== null && !ADDRESS.test(verifier)) errors.push("DEAL_VERIFIER is not a Solana address. Leave it unset to use a fresh one.");
  const buyerPath = v("DEMO_BUYER") ?? defaults.buyerPath;
  const buyerPathFromEnv = v("DEMO_BUYER") !== undefined;
  if (buyerPathFromEnv) {
    const bad = keypairFileProblem(buyerPath);
    if (bad) errors.push(bad);
  }
  const store = v("MISSION_STORE") ?? defaults.store;
  if (existsSync(store) && !statSync(store).isDirectory()) errors.push(`MISSION_STORE=${store} exists and is not a directory. Point it at the mission service's store directory.`);
  return errors.length ? { ok: false, errors } : { ok: true, value: { rpcUrl, buyerPath, buyerPathFromEnv, mint, verifier, store } };
}

/** Why a keypair file can't be used, or null. Never includes the file's content. */
export function keypairFileProblem(path: string): string | null {
  const how = "a Solana keypair JSON file (64 numbers, e.g. from `solana-keygen new -o <path>`), funded on devnet";
  if (!existsSync(path)) return `DEMO_BUYER=${path} does not exist. Point it at ${how}, or unset DEMO_BUYER to create one at the default path.`;
  if (!statSync(path).isFile()) return `DEMO_BUYER=${path} is not a file. Point it at ${how}.`;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return `DEMO_BUYER=${path} is not valid JSON. It must be ${how}.`; }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return `DEMO_BUYER=${path} is not a 64-byte keypair array. It must be ${how}.`;
  }
  return null;
}

/** The keypair bytes, already validated by keypairFileProblem. */
export function readKeypairFile(path: string): Uint8Array {
  const bad = keypairFileProblem(path);
  if (bad) throw new Error(bad);
  return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
}

/** What the preflight needs from the cluster; the script adapts its RPC client to this. */
export type ClusterView = {
  genesisHash(): Promise<string>;
  executable(address: string): Promise<boolean | null>; // null = no account
  exists(address: string): Promise<boolean>;
  lamports(address: string): Promise<bigint>;
  tokenBalance(owner: string): Promise<bigint>;
};

/** Checks the cluster before sending anything: reachable, devnet, program deployed, mint present, buyer funded. */
export async function preflight(
  view: ClusterView, p: { rpcUrl: string; program: string; mint: string; buyer: string; needUsdc: bigint; usdc: (v: bigint) => string },
): Promise<string[]> {
  let genesis: string;
  try {
    genesis = await view.genesisHash();
  } catch (e) {
    return [`Cannot reach DEAL_RPC_URL (${safeUrl(p.rpcUrl)}): ${e instanceof Error ? e.message.split(p.rpcUrl).join(safeUrl(p.rpcUrl)).slice(0, 200) : "no answer"}. Check the URL and this machine's network, or set DEAL_RPC_URL to another devnet RPC.`];
  }
  if (genesis !== DEVNET_GENESIS) return [`DEAL_RPC_URL (${safeUrl(p.rpcUrl)}) is not Solana devnet (genesis ${genesis.slice(0, 12)}...). Use a devnet RPC, e.g. ${DEVNET_RPC}`];
  const errors: string[] = [];
  const [prog, mint, sol, usdc] = await Promise.all([view.executable(p.program), view.exists(p.mint), view.lamports(p.buyer), view.tokenBalance(p.buyer)]);
  if (prog !== true) errors.push(`The deal_escrow program ${p.program} is not deployed on this cluster. Is DEAL_RPC_URL really devnet?`);
  if (!mint) errors.push(`DEAL_MINT ${p.mint} does not exist on devnet. Unset it for Circle's devnet USDC (${DEVNET_USDC}).`);
  if (sol < MIN_LAMPORTS) {
    errors.push(`The buyer ${p.buyer} has ${formatSol(sol)} SOL; it needs at least ${formatSol(MIN_LAMPORTS)} for fees and rent. Get devnet SOL at https://faucet.solana.com (or: solana airdrop 1 ${p.buyer} -u devnet).`);
  }
  if (usdc < p.needUsdc) {
    errors.push(`The buyer ${p.buyer} holds ${p.usdc(usdc)}; it needs ${p.usdc(p.needUsdc)} (budget + team fee). Get test USDC at https://faucet.circle.com (Solana devnet) or the site's faucet (https://fiducia-orpin.vercel.app).`);
  }
  return errors;
}

const formatSol = (l: bigint) => (Number(l) / Number(SOL)).toFixed(3).replace(/\.?0+$/, "");
