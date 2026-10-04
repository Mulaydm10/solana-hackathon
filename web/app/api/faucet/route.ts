// POST /api/faucet { wallet }: devnet test tokens, rate-limited (lib/faucet.ts). The faucet key is a server
// env secret (DEAL_FAUCET_KEY); without it the route answers NOT_CONFIGURED. Devnet only (env schema).
import { createFaucet } from "../../../lib/faucet";
import { parseEnv, requireEnv } from "../../../lib/env";
import { faucetSender } from "../../../lib/faucet-send";

export const dynamic = "force-dynamic";

let faucet: ReturnType<typeof createFaucet> | undefined;

export async function POST(req: Request) {
  const e = requireEnv(parseEnv(process.env), "faucet");
  if (!e.ok) return Response.json(e.body, { status: e.status });
  let wallet: unknown;
  try {
    wallet = ((await req.json()) as { wallet?: unknown }).wallet;
  } catch {
    return Response.json({ ok: false, reason: "BAD_REQUEST", message: "Send JSON: { \"wallet\": \"<address>\" }." }, { status: 400 });
  }
  if (typeof wallet !== "string") return Response.json({ ok: false, reason: "BAD_WALLET", message: "wallet must be a string." }, { status: 400 });
  faucet ??= createFaucet(await faucetSender(e.env));
  const client = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const r = await faucet(wallet, client);
  return Response.json(r, { status: r.ok ? 200 : r.reason === "BAD_WALLET" ? 400 : r.reason.endsWith("LIMIT") || r.reason === "DAILY_CAP" ? 429 : 502 });
}
