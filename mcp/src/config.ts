// Runtime configuration from the environment, validated once at startup. Fail closed: anything
// missing or malformed is a startup error, and mainnet is refused outright until the program is
// audited and its upgrade authority is settled (see docs/STATE.md).
import { z } from "zod";

const Env = z.object({
  DEAL_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  DEAL_RPC_URL: z.string().url().optional(),
  /** Path to the agent's own Solana keypair file. Only tools that sign need it. */
  DEAL_KEYPAIR: z.string().min(1).optional(),
  /** The token deals settle in (default: Circle devnet USDC, the same as x402 calls). */
  DEAL_MINT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  /** The marketplace verifier to name on deals (challenges need one). */
  DEAL_VERIFIER: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  /** The marketplace assessor to name on listings this agent publishes (must be registered on chain). */
  DEAL_ASSESSOR: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  /** The marketplace site, for search and for links a human must open (approvals). */
  DEAL_SITE_URL: z.string().url().optional(),
});

export type Config = {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  keypairPath: string | null;
  mint: string;
  verifier: string | null;
  assessor: string | null;
  siteUrl: string | null;
};

export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const DEFAULT_RPC = { devnet: "https://api.devnet.solana.com", localnet: "http://127.0.0.1:8899" } as const;

export type ConfigResult = { ok: true; config: Config } | { ok: false; reason: "BAD_CONFIG"; message: string };

export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
  if (env.DEAL_CLUSTER === "mainnet" || env.DEAL_CLUSTER === "mainnet-beta" || /mainnet/i.test(env.DEAL_RPC_URL ?? "")) {
    return { ok: false, reason: "BAD_CONFIG", message: "mainnet is not supported yet; use devnet or localnet" };
  }
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    return { ok: false, reason: "BAD_CONFIG", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const e = parsed.data;
  return {
    ok: true,
    config: {
      cluster: e.DEAL_CLUSTER, rpcUrl: e.DEAL_RPC_URL ?? DEFAULT_RPC[e.DEAL_CLUSTER], keypairPath: e.DEAL_KEYPAIR ?? null,
      mint: e.DEAL_MINT ?? DEVNET_USDC, verifier: e.DEAL_VERIFIER ?? null, assessor: e.DEAL_ASSESSOR ?? null, siteUrl: e.DEAL_SITE_URL ?? null,
    },
  };
}
