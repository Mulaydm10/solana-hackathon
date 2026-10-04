// Per-agent runner (PLAN §6.2): start refused unless the mandate is live, killed on revoke or timeout,
// and a compromised agent finds no way out except the runner's own channel to the broker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { containerArgs, nodeGovernsNetwork, startAgent, type RunnerDeps } from "../src/index.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const spec = (entry: string, o: { maxSecs?: number } = {}) => ({ mission: "M", agent: "A", entry: fixture(entry), ...o });

test("start is refused while the mandate is not live (the agent never runs, its secrets stay sealed)", async () => {
  const r = await startAgent(spec("agent-ok.mjs"), { live: async () => false, call: async () => null });
  assert.deepEqual(r.ok ? "started" : r.reason, "MANDATE_NOT_LIVE");
});

test("a well-behaved agent: its broker call and its message go through the runner, then it exits", async () => {
  const calls: unknown[] = [];
  const messages: unknown[] = [];
  const deps: RunnerDeps = {
    live: async () => true,
    call: async (token, action, args) => { calls.push({ token, action, args }); return { price: "1.08" }; },
    onMessage: async (_agent, m) => { messages.push(m); return "ok"; },
    pollMs: 50,
  };
  const r = await startAgent(spec("agent-ok.mjs"), deps);
  assert.ok(r.ok);
  const exit = await r.handle.done;
  assert.deepEqual(exit, { code: 0, reason: "exit" });
  assert.deepEqual(calls, [{ token: "t", action: "read", args: { q: 1 } }]);
  assert.deepEqual(messages, [{ got: { price: "1.08" } }]);
});

test("revoking the mandate on chain kills the running agent within one poll", async () => {
  let live = true;
  const r = await startAgent(spec("agent-sleep.mjs"), { live: async () => live, call: async () => null, pollMs: 50 });
  assert.ok(r.ok);
  setTimeout(() => { live = false; }, 150);
  const t0 = Date.now();
  const exit = await r.handle.done;
  assert.equal(exit.reason, "revoked");
  assert.ok(Date.now() - t0 < 2_000);
});

test("the wall-clock limit kills an agent that runs too long", async () => {
  const r = await startAgent(spec("agent-sleep.mjs", { maxSecs: 0.3 }), { live: async () => true, call: async () => null, pollMs: 1_000 });
  assert.ok(r.ok);
  assert.equal((await r.handle.done).reason, "timeout");
});

test("a compromised agent: no file reads outside its folder, no writes, no child processes, no runner secrets, no network", async () => {
  process.env.SECRET_FROM_RUNNER = "should-never-reach-the-agent";
  let report: Record<string, string> = {};
  const r = await startAgent(spec("agent-escape.mjs"), {
    live: async () => true,
    call: async () => null,
    onMessage: async (_a, m) => { report = m as Record<string, string>; return "ok"; },
    pollMs: 50,
  });
  assert.ok(r.ok);
  const deadline = Date.now() + 5_000;
  while (!report.envSecrets && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  r.handle.stop();
  await r.handle.done;
  delete process.env.SECRET_FROM_RUNNER;
  assert.equal(report.readEtcPasswd, "blocked");
  assert.equal(report.writeTmp, "blocked");
  assert.equal(report.childProcess, "blocked");
  assert.equal(report.envSecrets, "blocked");
  if (nodeGovernsNetwork()) {
    assert.equal(r.handle.isolation, "process-no-network");
    assert.equal(report.network, "blocked");
  } else {
    assert.equal(r.handle.isolation, "process-fs-only"); // stated, not hidden: use container mode for network isolation
  }
});

test("container mode: no network, read-only root, all capabilities dropped, non-root, resource limits", () => {
  const a = containerArgs({ mission: "M", agent: "A", entry: "/abs/agent.mjs", env: { ROLE: "researcher" } });
  const has = (...xs: string[]) => xs.every((x, i) => a[a.indexOf(xs[0]!) + i] === x);
  assert.ok(has("--network", "none"));
  assert.ok(a.includes("--read-only"));
  assert.ok(has("--cap-drop", "ALL"));
  assert.ok(has("--security-opt", "no-new-privileges"));
  assert.ok(has("--user", "1000:1000"));
  assert.ok(a.includes("--pids-limit") && a.includes("--memory"));
  assert.ok(has("-v", "/abs/agent.mjs:/app/agent.mjs:ro"));
  assert.ok(has("-e", "ROLE=researcher"));
});

test("container mode runs for real when Docker is available", { skip: process.env.AGENTS_DOCKER !== "1" && "set AGENTS_DOCKER=1 with Docker running" }, async () => {
  const r = await startAgent(spec("agent-ok.mjs"), { live: async () => true, call: async () => ({ price: "1" }), onMessage: async () => "ok", mode: "container", pollMs: 200 });
  assert.ok(r.ok);
  assert.equal((await r.handle.done).reason, "exit");
});
