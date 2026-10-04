// Server-only: the faucet's real sender. The faucet wallet pays fees, opens the recipient's token account if
// needed (idempotent), and sends `amount` of the site's mint with TransferChecked. Built from env on first use.
import { createClient, createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import {
  fetchMint, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { ServerEnv } from "./env";
import type { FaucetSend } from "./faucet";
import { USDC_DEVNET } from "./registry";

export async function faucetSender(env: ServerEnv): Promise<FaucetSend> {
  const faucet = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(env.DEAL_FAUCET_KEY!) as number[]));
  const client = createClient().use(signerPlugin(faucet)).use(solanaRpc({ rpcUrl: env.rpcUrl }));
  const mint = (env.DEAL_MINT ?? USDC_DEVNET) as Address;
  const { decimals } = (await fetchMint(client.rpc, mint)).data;
  const ata = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const source = await ata(faucet.address);
  return async (to, amount) => {
    try {
      const owner = to as Address;
      const sig = await client.sendTransaction([
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: faucet, owner, mint }),
        getTransferCheckedInstruction({ source, mint, destination: await ata(owner), authority: faucet, amount, decimals }),
      ]);
      return { ok: true, signature: String((sig as { signature?: string }).signature ?? sig) };
    } catch (e) {
      return { ok: false, reason: "SEND_FAILED", message: e instanceof Error ? e.message.slice(0, 200) : "send failed" };
    }
  };
}
