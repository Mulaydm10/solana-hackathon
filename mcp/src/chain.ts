// Opens the chain for the tools: the agent's own keypair (from DEAL_KEYPAIR) as signer and fee payer, the
// configured RPC, the deal library's context. The package never ships or fetches keys.
import { readFileSync } from "node:fs";
import { createClient, createKeyPairSignerFromBytes, generateKeyPairSigner, type TransactionSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import type { DealClient } from "@deal/chain";
import type { Config } from "./config.ts";
import type { ChainAccess } from "./tool.ts";

export async function openChain(config: Config): Promise<ChainAccess> {
  let signer: TransactionSigner | null = null;
  if (config.keypairPath) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(config.keypairPath, "utf8")) as number[]);
    signer = await createKeyPairSignerFromBytes(bytes);
  }
  // Read-only (no DEAL_KEYPAIR): a throwaway key satisfies the client's payer slot; write tools refuse
  // before sending (signer is null), so it never pays or signs anything.
  const client = createClient().use(signerPlugin(signer ?? (await generateKeyPairSigner()))).use(solanaRpc({ rpcUrl: config.rpcUrl }));
  return { ctx: { client: client as unknown as DealClient, mint: config.mint as never, confirmTimeoutMs: 45_000 }, signer };
}
