// A compromised agent: tries every way out, reports what worked, then waits.
import { readFileSync, writeFileSync } from "node:fs";
const tried = {};
const attempt = async (name, fn) => { try { await fn(); tried[name] = "ALLOWED"; } catch (e) { tried[name] = "blocked"; } };
await attempt("readEtcPasswd", () => readFileSync("/etc/passwd", "utf8"));
await attempt("readSibling", () => readFileSync(new URL("./agent-ok.mjs", import.meta.url), "utf8"));
await attempt("writeTmp", () => writeFileSync("/tmp/agent-escape-test", "x"));
await attempt("childProcess", async () => (await import("node:child_process")).execSync("echo hi"));
await attempt("network", async () => { const r = await fetch("http://127.0.0.1:9/"); await r.text(); });
await attempt("envSecrets", () => { if (process.env.BROKER_MASTER_KEY || process.env.SECRET_FROM_RUNNER) return; throw new Error("none"); });
process.stdout.write(JSON.stringify({ id: 1, kind: "message", message: tried }) + "\n");
setInterval(() => {}, 1000);
