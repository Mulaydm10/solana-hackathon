// Runtime configuration from the environment, validated once at startup. Fail closed: anything
// missing or malformed is a startup error, and mainnet is refused outright until the program is
// audited and its upgrade authority is settled (see docs/STATE.md).
import { z } from "zod";

const Env = z.object({
  DEAL_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  DEAL_RPC_URL: z.string().url().optional(),
  /** Path to the agent's own Solana keypair file. Only tools that sign need it. */
  DEAL_KEYPAIR: z.string().min(1).optional(),
});

export type Config = {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  keypairPath: string | null;
};

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
  return { ok: true, config: { cluster: e.DEAL_CLUSTER, rpcUrl: e.DEAL_RPC_URL ?? DEFAULT_RPC[e.DEAL_CLUSTER], keypairPath: e.DEAL_KEYPAIR ?? null } };
}
