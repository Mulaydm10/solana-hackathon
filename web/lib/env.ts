// Server-side environment, validated by a schema. Secrets live only in Vercel environment variables
// (never in the repo, never sent to the browser: this module must only be imported by server code).
// Routes that need a secret call requireEnv(), which fails closed with a reason code instead of
// running half-configured.
import { z } from "zod";

const keypairBytes = z
  .string()
  .refine((s) => {
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) && a.length === 64 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
    } catch {
      return false;
    }
  }, "must be a JSON array of 64 bytes");

const Schema = z.object({
  DEAL_CLUSTER: z.enum(["devnet", "localnet"]).default("devnet"),
  DEAL_RPC_URL: z.string().url().optional(),
  /** Drafting model key (Claude). Optional: drafting falls back to rules without it. */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  /** Verifier keypair as a JSON array of 64 bytes. Needed only by the verifier route. */
  DEAL_VERIFIER_KEY: keypairBytes.optional(),
  /** Devnet faucet wallet (64-byte JSON array) holding the test token. Needed only by /api/faucet. */
  DEAL_FAUCET_KEY: keypairBytes.optional(),
  /** The token the site settles in (base58 mint). Default: Circle devnet USDC. */
  DEAL_MINT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
});

export type ServerEnv = z.infer<typeof Schema> & { rpcUrl: string };
export type EnvResult = { ok: true; env: ServerEnv } | { ok: false; reason: "BAD_CONFIG"; message: string };

const DEFAULT_RPC = { devnet: "https://api.devnet.solana.com", localnet: "http://127.0.0.1:8899" } as const;

export function parseEnv(raw: Record<string, string | undefined>): EnvResult {
  if (/mainnet/i.test(`${raw.DEAL_CLUSTER ?? ""} ${raw.DEAL_RPC_URL ?? ""}`)) {
    return { ok: false, reason: "BAD_CONFIG", message: "mainnet is not supported yet" };
  }
  // Vercel sets unused variables to "", which should mean "not set".
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
  const r = Schema.safeParse(cleaned);
  if (!r.success) return { ok: false, reason: "BAD_CONFIG", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, env: { ...r.data, rpcUrl: r.data.DEAL_RPC_URL ?? DEFAULT_RPC[r.data.DEAL_CLUSTER] } };
}

export type Capability = "drafting" | "verifier" | "faucet";
const NEEDS: Record<Capability, keyof ServerEnv> = { drafting: "ANTHROPIC_API_KEY", verifier: "DEAL_VERIFIER_KEY", faucet: "DEAL_FAUCET_KEY" };

/** For routes that cannot run without a secret: a typed refusal instead of a half-configured run. */
export function requireEnv(r: EnvResult, cap: Capability): { ok: true; env: ServerEnv } | { ok: false; status: number; body: { ok: false; reason: string; message: string } } {
  if (!r.ok) return { ok: false, status: 500, body: { ok: false, reason: r.reason, message: r.message } };
  if (!r.env[NEEDS[cap]]) return { ok: false, status: 503, body: { ok: false, reason: "NOT_CONFIGURED", message: `${cap} is not configured on this deployment` } };
  return { ok: true, env: r.env };
}

/** What a public health check may reveal: which capabilities exist, never the secrets. */
export function health(r: EnvResult) {
  if (!r.ok) return { ok: false as const, reason: r.reason };
  return {
    ok: true as const,
    cluster: r.env.DEAL_CLUSTER,
    capabilities: { drafting: Boolean(r.env.ANTHROPIC_API_KEY), verifier: Boolean(r.env.DEAL_VERIFIER_KEY), faucet: Boolean(r.env.DEAL_FAUCET_KEY) },
  };
}
