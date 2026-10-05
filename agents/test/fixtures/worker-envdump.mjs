// Test fixture: reports its whole environment as its result, so a test can prove no secret reached a worker.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let next = 1;
rl.on("line", (l) => { const r = JSON.parse(l); pending.get(r.id)?.(r.result); pending.delete(r.id); });
const ask = (req) => new Promise((res) => { const id = next++; pending.set(id, res); process.stdout.write(JSON.stringify({ id, ...req }) + "\n"); });
const dump = Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join("\n").replace(/[^\x20-\x7e\n]/g, "");
await ask({ kind: "message", message: { type: "result", output: dump.slice(0, 4_000) || "empty" } });
process.exit(0);
