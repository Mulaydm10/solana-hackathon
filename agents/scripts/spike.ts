// x402-on-Solana devnet spike (#65, PLAN §5). Runs the real thing end to end:
//   buyer agent (own key, devnet USDC) -> local seller server behind `createPayGate` -> x402.org facilitator -> devnet.
// Case "answered": a valid answer, so the payment must settle and the seller's USDC goes up by exactly the price.
// Case "unanswered": the seller's code returns nothing valid, so the payment must never settle; balances unchanged.
// Used by `npm run spike:x402` (prints findings) and by test/pay.devnet.test.ts (AGENTS_NET=1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { fetchMaybeToken, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createPayGate, payAndCall, SOLANA_DEVNET, USDC_DEVNET, type Answer } from "../src/index.ts";

export const KEYS = new URL("../.keys/", import.meta.url);
export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
/** 0.01 USDC per call. */
export const PRICE = 10_000n;

async function keyFile(name: string): Promise<KeyPairSigner> {
  const url = new URL(`${name}.json`, KEYS);
  if (!existsSync(url)) {
    mkdirSync(KEYS, { recursive: true });
    // Solana CLI format: 32-byte seed then 32-byte public key.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const pub = getAddressEncoder().encode((await createKeyPairSignerFromPrivateKeyBytes(seed)).address);
    writeFileSync(url, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(url, "utf8")) as number[]));
}

/** Devnet-only keys under agents/.keys (gitignored). The buyer needs devnet USDC (faucet.circle.com) and a little SOL. */
export async function keys() {
  return { buyer: await keyFile("buyer"), seller: await keyFile("seller") };
}

async function usdc(rpc: ReturnType<typeof clientFor>["rpc"], owner: Address): Promise<bigint | null> {
  const [ata] = await findAssociatedTokenPda({ owner, mint: USDC_DEVNET as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const t = await fetchMaybeToken(rpc, ata);
  return t.exists ? t.data.amount : null;
}

const clientFor = (payer: KeyPairSigner) => createClient().use(signerPlugin(payer)).use(solanaRpc({ rpcUrl: RPC_URL }));

export type CaseResult = { status: number; charged: boolean; transaction?: string; buyerDelta: bigint; sellerDelta: bigint; reason?: string };
export type SpikeResult = { ready: true; answered: CaseResult; unanswered: CaseResult } | { ready: false; why: string; buyer: Address; seller: Address };

/** Waits until the balance differs from `before` (settlement confirms asynchronously) or the timeout passes. */
async function settledBalance(read: () => Promise<bigint | null>, before: bigint, expectChange: boolean): Promise<bigint> {
  const end = Date.now() + (expectChange ? 60_000 : 15_000);
  let now = (await read()) ?? 0n;
  while (Date.now() < end && (expectChange ? now === before : true)) {
    await new Promise((r) => setTimeout(r, 2_000));
    now = (await read()) ?? 0n;
  }
  return now;
}

export async function runSpike(): Promise<SpikeResult> {
  const { buyer, seller } = await keys();
  const client = clientFor(buyer);
  const sol = (await client.rpc.getBalance(buyer.address).send()).value;
  const buyerUsdc = await usdc(client.rpc, buyer.address);
  if (buyerUsdc === null || buyerUsdc < 2n * PRICE) {
    return { ready: false, why: `buyer needs at least ${2n * PRICE} base units of devnet USDC (has ${buyerUsdc ?? "no account"})`, buyer: buyer.address, seller: seller.address };
  }
  // x402 `exact` does not create the payee's token account; the seller must have one before it can be paid.
  if ((await usdc(client.rpc, seller.address)) === null) {
    if (sol < 3_000_000n) return { ready: false, why: `the seller has no USDC account: send it any devnet USDC from the faucet, or give the buyer ~0.003 devnet SOL to open it (buyer has ${sol} lamports)`, buyer: buyer.address, seller: seller.address };
    await client.sendTransaction([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: seller.address, mint: USDC_DEVNET as Address })]);
  }

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator).register(SOLANA_DEVNET, new ExactSvmScheme());
  await server.initialize();
  let behaviour: "answer" | "nothing" = "answer";
  const http = createServer(async (req, res) => {
    const gate = createPayGate(server, { scheme: "exact", network: SOLANA_DEVNET, payTo: seller.address, amount: PRICE, asset: USDC_DEVNET }, {
      url: `http://${req.headers.host}${req.url}`, mimeType: "application/json",
    });
    const run = async (): Promise<Answer> => (behaviour === "answer" ? { status: 200, body: { quote: "SOL/USDC", price: 150.25 } } : { status: 200, body: {} });
    const out = await gate.handle((n) => req.headers[n.toLowerCase()] as string | undefined, run, (b) => typeof (b as { price?: unknown })?.price === "number");
    res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/quote`;
  const expect = { network: SOLANA_DEVNET, asset: USDC_DEVNET, payTo: seller.address, maxAmount: PRICE };

  const once = async (b: typeof behaviour): Promise<CaseResult> => {
    behaviour = b;
    const [b0, s0] = [(await usdc(client.rpc, buyer.address)) ?? 0n, (await usdc(client.rpc, seller.address)) ?? 0n];
    const r = await payAndCall(url, {}, buyer, expect, { rpcUrl: RPC_URL });
    const charged = r.ok && r.charged;
    const s1 = await settledBalance(() => usdc(client.rpc, seller.address), s0, charged);
    const b1 = (await usdc(client.rpc, buyer.address)) ?? 0n;
    return r.ok
      ? { status: r.status, charged: r.charged, transaction: r.transaction, buyerDelta: b1 - b0, sellerDelta: s1 - s0 }
      : { status: r.status ?? 0, charged: false, reason: `${r.reason}: ${r.message}`, buyerDelta: b1 - b0, sellerDelta: s1 - s0 };
  };
  try {
    return { ready: true, answered: await once("answer"), unanswered: await once("nothing") };
  } finally {
    http.close();
  }
}
