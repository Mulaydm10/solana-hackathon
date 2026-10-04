// A well-behaved agent: asks the broker once through the runner, reports, exits.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ id: 1, kind: "call", token: "t", action: "read", args: { q: 1 } }) + "\n");
rl.on("line", (l) => {
  const r = JSON.parse(l);
  if (r.id !== 1) return; // only the broker answer triggers the report
  process.stdout.write(JSON.stringify({ id: 2, kind: "message", message: { got: r.result } }) + "\n");
  setTimeout(() => process.exit(0), 50);
});
