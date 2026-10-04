// One-time devnet setup: seller keys, a test "USDC" mint (we are its mint authority; no real value),
// buyer balance, seller token accounts, and surface/.keys/config.json. Safe to re-run.
// The buyer/fee payer is the Solana CLI wallet (SOLANA_KEYPAIR to override); fund it from faucet.solana.com.
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createClient, generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync,
} from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { SERVICES } from "../src/catalog.ts";
import { CONFIG_PATH, KEYS_DIR, loadOrCreateSigner, loadSigner, type DeskConfig } from "../src/keys.ts";
import { withRetry } from "../src/retry.ts";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const buyerKeyPath = process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const DECIMALS = 6;
const SYMBOL = "USDC";

const buyer = await loadSigner(buyerKeyPath);
const client = createClient().use(signerPlugin(buyer)).use(solanaRpc({ rpcUrl }));
const send = (plan: Parameters<typeof client.sendTransaction>[0]) => withRetry(() => client.sendTransaction(plan));
const saveConfig = (mint: Address) => {
  const cfg: DeskConfig = { rpcUrl, buyerKeyPath, mint, decimals: DECIMALS, symbol: SYMBOL, sellers };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
};

const { value: sol } = await withRetry(() => client.rpc.getBalance(buyer.address).send());
console.log(`buyer ${buyer.address}: ${Number(sol) / 1e9} SOL`);
if (sol < lamports(50_000_000n)) {
  console.error("Buyer needs devnet SOL: https://faucet.solana.com (devnet) -> " + buyer.address);
  process.exit(1);
}

const program = await withRetry(() => client.rpc.getAccountInfo(DEAL_ESCROW_PROGRAM_ADDRESS, { encoding: "base64" }).send());
console.log(program.value?.executable ? `program ${DEAL_ESCROW_PROGRAM_ADDRESS} is deployed` : `WARNING: program ${DEAL_ESCROW_PROGRAM_ADDRESS} not deployed yet`);

const sellers: Record<string, string> = {};
for (const s of SERVICES) {
  sellers[s.id] = `${KEYS_DIR}sellers/${s.id}.json`;
  await loadOrCreateSigner(sellers[s.id]!);
}

let mint: Address;
if (existsSync(CONFIG_PATH)) {
  mint = (JSON.parse((await import("node:fs")).readFileSync(CONFIG_PATH, "utf8")) as DeskConfig).mint as Address;
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
  saveConfig(mint); // save now, so a failed run resumes with this mint instead of creating another
  console.log(`created test mint ${mint}`);
  await send(
    await getMintToATAInstructionPlanAsync({
      payer: buyer, owner: buyer.address, mint, mintAuthority: buyer, amount: 1000n * 10n ** BigInt(DECIMALS), decimals: DECIMALS,
    }),
  );
  console.log(`minted 1000 ${SYMBOL} (test) to the buyer`);
}

for (const [id, path] of Object.entries(sellers)) {
  const s = await loadSigner(path);
  await send([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: s.address, mint })]);
  console.log(`seller ${id}: ${s.address} (token account ready)`);
}

saveConfig(mint);
console.log(`wrote ${CONFIG_PATH}`);
