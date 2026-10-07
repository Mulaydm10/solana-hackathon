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
  /** The marketplace assessor's keypair (64-byte JSON array): re-assesses and signs attest_listing (#110). */
  DEAL_ASSESSOR_KEY: keypairBytes.optional(),
  /** Custody master key, 64 hex (32 bytes): seals every per-listing custody key at rest (#110). */
  DEAL_CUSTODY_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters").optional(),
  /** Vercel Blob read-write token: listing documents and custody storage on Vercel (else files on disk). */
  BLOB_READ_WRITE_TOKEN: z.string().min(10).optional(),
  /** The mission service (agents runtime on a long-running host) that runs hired teams (#73). */
  MISSION_SERVICE_URL: z.string().url().optional(),
  /** Bearer token for the mission service; server routes only. */
  MISSION_SERVICE_TOKEN: z.string().min(32).optional(),
  /** Demo buyer for judges (64-byte JSON array), devnet only: signs demo missions it creates (#183). Server only. */
  DEMO_BUYER_KEY: keypairBytes.optional(),
  // Machine economy demo (#229, peaq track): a simulated robot pays a simulated charging pad. Devnet/testnet keys,
  // server only. The fleet mission's owner key is never here: the owner sets the rules once, offline (#228).
  /** The robot's agent key (64-byte JSON array): opens and releases charges under its mission mandate. */
  ROBOT_AGENT_KEY: keypairBytes.optional(),
  /** The charging pad's key (64-byte JSON array): accepts, delivers, and signs its meter readings. */
  PAD_KEY: keypairBytes.optional(),
  /** The fleet mission (base58) whose mandate binds the robot. */
  MACHINE_MISSION: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  /** peaq event signer, 0x + 64 hex. */
  PEAQ_EVENT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex characters").optional(),
  PEAQ_RPC_URL: z.string().url().optional(),
  /** peaq deployment id, e.g. agung-2026-08-28 or peaq-mainnet. */
  PEAQ_DEPLOYMENT: z.string().min(3).optional(),
  /** peaq EventRegistry contract (0x + 40 hex). */
  PEAQ_EVENT_REGISTRY: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** peaq's id for Solana as an event source (the SDK's SOLANA_PROTOCOL_CHAIN_ID is 5). */
  PEAQ_SOURCE_CHAIN_ID: z.coerce.number().int().min(0).optional(),
  /** Optional peaq block explorer base for tx links, e.g. https://…/tx/ (no link when unset). */
  PEAQ_EXPLORER_TX_URL: z.string().url().optional(),
  /** Bearer secret for POST /api/machines/tick (the mission service's ticker, #253). Not part of "machines": the page works without it. */
  MACHINE_TICK_SECRET: z.string().min(32).optional(),
  ROBOT_MACHINE_ID: z.string().regex(/^[1-9]\d{0,77}$/).optional(),
  PAD_MACHINE_ID: z.string().regex(/^[1-9]\d{0,77}$/).optional(),
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

export type Capability = "drafting" | "verifier" | "missions" | "faucet" | "sell" | "demo" | "machines";
const NEEDS: Record<Capability, (keyof ServerEnv)[]> = {
  drafting: ["ANTHROPIC_API_KEY"],
  verifier: ["DEAL_VERIFIER_KEY"],
  missions: ["MISSION_SERVICE_URL", "MISSION_SERVICE_TOKEN"],
  faucet: ["DEAL_FAUCET_KEY"],
  sell: ["DEAL_ASSESSOR_KEY", "DEAL_CUSTODY_KEY"],
  demo: ["DEMO_BUYER_KEY", "MISSION_SERVICE_URL", "MISSION_SERVICE_TOKEN"],
  machines: [
    "ROBOT_AGENT_KEY", "PAD_KEY", "MACHINE_MISSION", "PEAQ_EVENT_KEY", "PEAQ_RPC_URL", "PEAQ_DEPLOYMENT", "PEAQ_EVENT_REGISTRY",
    "PEAQ_SOURCE_CHAIN_ID", "ROBOT_MACHINE_ID", "PAD_MACHINE_ID",
  ],
};

/** For routes that cannot run without a secret: a typed refusal instead of a half-configured run. */
export function requireEnv(r: EnvResult, cap: Capability): { ok: true; env: ServerEnv } | { ok: false; status: number; body: { ok: false; reason: string; message: string } } {
  if (!r.ok) return { ok: false, status: 500, body: { ok: false, reason: r.reason, message: r.message } };
  // The demo buyer signs with a server key: devnet only, never localnet tricks or anything else.
  if ((cap === "demo" || cap === "machines") && r.env.DEAL_CLUSTER !== "devnet") return { ok: false, status: 503, body: { ok: false, reason: "NOT_CONFIGURED", message: cap === "demo" ? "the demo runs on devnet only" : "the machine demo runs on devnet only" } };
  // Missing means unset: a value that is legitimately 0 (PEAQ_SOURCE_CHAIN_ID=0, #226) counts as configured.
  if (NEEDS[cap].some((k) => r.env[k] === undefined)) return { ok: false, status: 503, body: { ok: false, reason: "NOT_CONFIGURED", message: `${cap} is not configured on this deployment` } };
  return { ok: true, env: r.env };
}

/** What a public health check may reveal: which capabilities exist, never the secrets. */
export function health(r: EnvResult) {
  if (!r.ok) return { ok: false as const, reason: r.reason };
  return {
    ok: true as const,
    cluster: r.env.DEAL_CLUSTER,
    capabilities: {
      drafting: Boolean(r.env.ANTHROPIC_API_KEY),
      verifier: Boolean(r.env.DEAL_VERIFIER_KEY),
      missions: Boolean(r.env.MISSION_SERVICE_URL && r.env.MISSION_SERVICE_TOKEN),
      faucet: Boolean(r.env.DEAL_FAUCET_KEY),
      sell: Boolean(r.env.DEAL_ASSESSOR_KEY && r.env.DEAL_CUSTODY_KEY),
      demo: demoAvailable(r),
    },
  };
}

/** Whether "Try the demo" is offered: the demo buyer key and the mission service are configured, on devnet. */
export const demoAvailable = (r: EnvResult) => requireEnv(r, "demo").ok;
