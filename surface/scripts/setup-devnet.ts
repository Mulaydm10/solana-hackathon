// One-time setup (safe to re-run): demo keys (sellers, verifier, approver), a test "USDC" mint we
// control (no real value), buyer and seller balances, token accounts, and the buyer's on-chain
// spending policy. Writes surface/.keys/config.json as soon as the mint exists, so a failed run
// resumes instead of creating another mint.
// The buyer/fee payer is the Solana CLI wallet (SOLANA_KEYPAIR to override); fund it from
// faucet.solana.com. SOLANA_RPC_URL selects the cluster (default devnet).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createClient, generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS, deals, getPolicy, type DealClient } from "@deal/chain";
import { SERVICES } from "../src/catalog.ts";
import { CONFIG_PATH, KEYS_DIR, loadOrCreateSigner, loadSigner, type DeskConfig } from "../src/keys.ts";
import { withRetry } from "../src/retry.ts";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const buyerKeyPath = process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const DECIMALS = 6;
const SYMBOL = "USDC";
const USDC = 10n ** BigInt(DECIMALS);
/** Demo buyer policy: what the program will enforce for every deal this buyer opens. */
const POLICY = { periodSecs: 86_400, periodBudget: 300n * USDC, maxPrice: 50n * USDC, approvalThreshold: 20n * USDC };

const buyer = await loadSigner(buyerKeyPath);
const client = createClient().use(signerPlugin(buyer)).use(solanaRpc({ rpcUrl }));
const send = (plan: Parameters<typeof client.sendTransaction>[0]) => withRetry(() => client.sendTransaction(plan));

const { value: sol } = await withRetry(() => client.rpc.getBalance(buyer.address).send());
console.log(`buyer ${buyer.address}: ${Number(sol) / 1e9} SOL`);
if (sol < lamports(50_000_000n)) {
  console.error("Buyer needs devnet SOL: https://faucet.solana.com (devnet) -> " + buyer.address);
  process.exit(1);
}
const program = await withRetry(() => client.rpc.getAccountInfo(DEAL_ESCROW_PROGRAM_ADDRESS, { encoding: "base64" }).send());
if (!program.value?.executable) {
  console.error(`program ${DEAL_ESCROW_PROGRAM_ADDRESS} is not deployed on ${rpcUrl}`);
  process.exit(1);
}

const sellers: Record<string, string> = {};
for (const s of SERVICES) {
  sellers[s.id] = `${KEYS_DIR}sellers/${s.id}.json`;
  await loadOrCreateSigner(sellers[s.id]!);
}
const verifierKeyPath = `${KEYS_DIR}verifier.json`;
const approverKeyPath = `${KEYS_DIR}approver.json`;
const verifier = await loadOrCreateSigner(verifierKeyPath);
const approver = await loadOrCreateSigner(approverKeyPath);
const saveConfig = (mint: Address) => {
  const cfg: DeskConfig = { rpcUrl, buyerKeyPath, mint, decimals: DECIMALS, symbol: SYMBOL, sellers, verifierKeyPath, approverKeyPath };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
};

let mint: Address;
const previous = existsSync(CONFIG_PATH) ? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DeskConfig>) : null;
if (previous?.mint && previous.rpcUrl === rpcUrl) {
  mint = previous.mint as Address;
  console.log(`reusing mint ${mint}`);
} else {
  const newMint = await generateKeyPairSigner();
  try {
    await client.sendTransaction(
      await getCreateMintInstructionPlan(client, { payer: buyer, newMint, decimals: DECIMALS, mintAuthority: buyer.address }),
    );
  } catch (e) {
    // A 429 can arrive after the mint landed; only fail if it really is not there.
    const exists = await withRetry(() => client.rpc.getAccountInfo(newMint.address, { encoding: "base64" }).send());
    if (!exists.value) throw e;
  }
  mint = newMint.address;
  console.log(`created test mint ${mint}`);
}
saveConfig(mint);

const balanceOf = async (owner: Address) => {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const t = await withRetry(() => fetchMaybeToken(client.rpc, a));
  return t.exists ? t.data.amount : 0n;
};
/**
 * Top an account up to `target` test tokens. Never blind-retries a send: a 429 can arrive after
 * the mint landed (seen live: a seller got minted twice). After any failure the balance is re-read
 * and only the remaining shortfall is minted.
 */
const topUp = async (owner: Address, target: bigint) => {
  for (let attempt = 1; ; attempt++) {
    const have = await balanceOf(owner);
    if (have >= target) return;
    try {
      await client.sendTransaction(
        await getMintToATAInstructionPlanAsync({ payer: buyer, owner, mint, mintAuthority: buyer, amount: target - have, decimals: DECIMALS }),
      );
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1_500 * attempt)); // then re-read: it may have landed
    }
  }
};

await topUp(buyer.address, 1000n * USDC);
console.log(`buyer holds ${(await balanceOf(buyer.address)) / USDC} ${SYMBOL} (test)`);
for (const [id, path] of Object.entries(sellers)) {
  const s = await loadSigner(path);
  await topUp(s.address, 100n * USDC); // sellers stake from this
  console.log(`seller ${id}: ${s.address} (${(await balanceOf(s.address)) / USDC} ${SYMBOL} for stakes)`);
}
for (const k of [verifier, approver]) {
  await send([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: k.address, mint })]);
}

const ctx = { client: client as unknown as DealClient, mint };
const sellerAddresses = await Promise.all(Object.values(sellers).map(async (p) => (await loadSigner(p)).address));
if (await getPolicy(ctx, buyer.address)) {
  console.log("buyer policy already exists (kept as is)");
} else {
  const r = await deals.initPolicy(ctx, buyer, {
    ...POLICY, approver: approver.address, allowAnySeller: false, allowedSellers: sellerAddresses,
  });
  if (!r.ok) {
    console.error(`policy: ${r.reason} ${r.message}`);
    process.exit(1);
  }
  console.log(`buyer policy created: budget ${POLICY.periodBudget / USDC}/day, max ${POLICY.maxPrice / USDC}, approval above ${POLICY.approvalThreshold / USDC}`);
}
console.log(`verifier ${verifier.address} · approver ${approver.address}`);
console.log(`wrote ${CONFIG_PATH}`);
