// Prints the live MCR-style score of agung machines (read-only; opt-in network).
//   AGENTS_NET=1 node --import tsx scripts/machines/score.ts [machineId ...]   (default 348 349)
//   env: PEAQ_RPC_URL, PEAQ_EVENT_REGISTRY, SCORE_FROM_BLOCK (default 11000000, before the machines existed)
// Machines are bonded at registration (activate.ts), so `bonded` is true here.
import { createPublicClient, http } from "viem";
import { readMachineEvents, scoreMachine, type LogIo } from "../../src/machines/score.ts";

if (process.env.AGENTS_NET !== "1") { console.log("set AGENTS_NET=1 to read live agung logs"); process.exit(0); }
const rpcUrl = process.env.PEAQ_RPC_URL ?? "https://peaq-agung.api.onfinality.io/public";
const registry = process.env.PEAQ_EVENT_REGISTRY ?? "0x2DAD8905380993940e340C5cE6d313d5c2780040";
const ids = process.argv.slice(2).map(BigInt);
const pub = createPublicClient({ transport: http(rpcUrl) });
const io: LogIo = {
  getLogs: async (q) => {
    const logs = await pub.request({ method: "eth_getLogs", params: [{ address: q.address as `0x${string}`, topics: q.topics as `0x${string}`[], fromBlock: `0x${q.fromBlock.toString(16)}`, toBlock: `0x${q.toBlock.toString(16)}` }] });
    return logs.map((l) => ({ topics: [...l.topics], data: l.data, transactionHash: l.transactionHash!, blockNumber: BigInt(l.blockNumber!) }));
  },
  blockNumber: () => pub.getBlockNumber(),
  blockTimestamp: async (b) => Number((await pub.getBlock({ blockNumber: b })).timestamp),
};
const from = BigInt(process.env.SCORE_FROM_BLOCK ?? "11000000");
for (const id of ids.length ? ids : [348n, 349n]) {
  const r = await readMachineEvents(io, registry, id, from);
  if (!r.ok) { console.log(`machine ${id}: ${r.reason}: ${r.message}`); continue; }
  const s = scoreMachine(r.events, { bonded: true, nowSecs: Math.floor(Date.now() / 1000) });
  console.log(`machine ${id}: ${s.events} events to block ${r.toBlock}`, JSON.stringify(s));
}
