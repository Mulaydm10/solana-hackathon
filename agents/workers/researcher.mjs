// Deterministic researcher: reads a quote through its broker capability, buys one data item from the
// seller named in PAYEE (default: the first payee of its mandate, PAYEES) via the orchestrator, which signs
// agent_spend, and reports. With no payee in its mandate it buys nothing. Node built-ins only.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let next = 1;
rl.on("line", (l) => { const r = JSON.parse(l); pending.get(r.id)?.(r.result); pending.delete(r.id); });
const ask = (req) => new Promise((res) => { const id = next++; pending.set(id, res); process.stdout.write(JSON.stringify({ id, ...req }) + "\n"); });
const payee = process.env.PAYEE || (process.env.PAYEES ?? "").split(",").find(Boolean);
const cap = /^\d+$/.test(process.env.PER_TX_CAP ?? "") ? BigInt(process.env.PER_TX_CAP) : 1000000n;
const amount = process.env.AMOUNT ?? String(cap < 1000000n ? cap : 1000000n);
const quote = await ask({ kind: "call", token: process.env.CAP_MARKET ?? "", action: "read", args: {} });
const spend = payee
  ? await ask({ kind: "message", message: { type: "spend", payee, amount, receipt: "ab".repeat(32) } })
  : { ok: false, reason: "NO_PAYEE (the mandate names no seller)" };
const price = quote?.ok ? quote.result.price : `n/a (${quote?.reason ?? "no market capability"})`;
await ask({ kind: "message", message: { type: "result", output: `EURUSD ${price}; data purchase ${spend?.ok ? "paid" : "refused: " + (spend?.reason ?? "?")}` } });
process.exit(0);
