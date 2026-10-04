// Deterministic researcher: reads a quote through its broker capability, buys one data item from the
// seller named in PAYEE (via the orchestrator, which signs agent_spend), reports. Node built-ins only.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let next = 1;
rl.on("line", (l) => { const r = JSON.parse(l); pending.get(r.id)?.(r.result); pending.delete(r.id); });
const ask = (req) => new Promise((res) => { const id = next++; pending.set(id, res); process.stdout.write(JSON.stringify({ id, ...req }) + "\n"); });
const quote = await ask({ kind: "call", token: process.env.CAP_MARKET ?? "", action: "read", args: {} });
const spend = await ask({ kind: "message", message: { type: "spend", payee: process.env.PAYEE, amount: process.env.AMOUNT ?? "1000000", receipt: "ab".repeat(32) } });
const price = quote?.ok ? quote.result.price : "n/a";
await ask({ kind: "message", message: { type: "result", output: `EURUSD ${price}; data purchase ${spend?.ok ? "paid" : "refused: " + (spend?.reason ?? "?")}` } });
process.exit(0);
