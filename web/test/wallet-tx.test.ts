// The wallet gets a transaction that simulated on the site's RPC and carries its own compute budget, so the wallet
// has nothing to rewrite (#146); a transaction that would fail never reaches the wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { address, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { SIGN_AND_SEND, sendWithWallet } from "../lib/wallet-tx.ts";

const PAYER = "3maGEwkqjGW9B6V9RD3zsVRUYZnbyqnyDTNtrDzjUgbY";
const IX: Instruction = { programAddress: address("CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV"), data: new Uint8Array([1, 2, 3]) };

async function rpcServer(sim: Record<string, unknown>) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = method === "getLatestBlockhash"
        ? { context: { slot: 1 }, value: { blockhash: "GXjDGiNxRbPbweXFfEXQE5hEF9JvCa8fyvYsACHLffhr", lastValidBlockHeight: 100 } }
        : { context: { slot: 1 }, value: sim };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function wallet() {
  const sent: Uint8Array[] = [];
  const w = { features: { [SIGN_AND_SEND]: { signAndSendTransaction: async (i: { transaction: Uint8Array }) => (sent.push(i.transaction), [{ signature: new Uint8Array(64) }]) } } } as unknown as Wallet;
  return { w, sent, account: { address: PAYER } as WalletAccount };
}

test("the wallet gets a simulated transaction with a compute limit and price set from the simulation", async () => {
  const rpc = await rpcServer({ err: null, logs: [], unitsConsumed: 23_194 });
  const { w, sent, account } = wallet();
  try {
    assert.equal((await sendWithWallet(w, account, rpc.url, [IX])).ok, true);
    const tx = getTransactionDecoder().decode(sent[0]!);
    const ixs = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)).instructions as readonly Instruction[];
    assert.deepEqual(ixs.map((i) => i.programAddress), ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", IX.programAddress]);
    const limit = new DataView(ixs[0]!.data!.buffer, ixs[0]!.data!.byteOffset);
    assert.deepEqual([limit.getUint8(0), limit.getUint32(1, true)], [2, Math.ceil(23_194 * 1.2) + 10_000]);
    assert.equal(ixs[1]!.data![0], 3);
  } finally {
    rpc.close();
  }
});

test("a transaction that fails simulation is refused with the program's reason, before the wallet opens", async () => {
  const rpc = await rpcServer({ err: { InstructionError: [1, { Custom: 6053 }] }, logs: ["Program log: AnchorError thrown. Error Code: AssessorNotRegistered. Error Number: 6053. Error Message: The assessor is not on the registry of assessors."], unitsConsumed: 21_100 });
  const { w, sent, account } = wallet();
  try {
    const r = await sendWithWallet(w, account, rpc.url, [IX]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "SIMULATION_FAILED");
    assert.match(!r.ok ? r.message : "", /registry of assessors/);
    assert.equal(sent.length, 0);
  } finally {
    rpc.close();
  }
});
