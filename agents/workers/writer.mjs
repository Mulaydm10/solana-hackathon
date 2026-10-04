// Deterministic writer (until the Claude workers of PLAN §11): turns the goal into a short report.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let next = 1;
rl.on("line", (l) => { const r = JSON.parse(l); pending.get(r.id)?.(r.result); pending.delete(r.id); });
const ask = (req) => new Promise((res) => { const id = next++; pending.set(id, res); process.stdout.write(JSON.stringify({ id, ...req }) + "\n"); });
await ask({ kind: "message", message: { type: "result", output: `Report for: ${process.env.GOAL ?? ""}` } });
process.exit(0);
