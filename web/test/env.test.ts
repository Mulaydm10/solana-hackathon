import { test } from "node:test";
import assert from "node:assert/strict";
import { health, parseEnv, requireEnv } from "../lib/env.ts";

const KEY = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));

test("defaults: devnet, public RPC, no capabilities", () => {
  const r = parseEnv({});
  assert.equal(r.ok && r.env.rpcUrl, "https://api.devnet.solana.com");
  assert.deepEqual(health(r), { ok: true, cluster: "devnet", capabilities: { drafting: false, verifier: false, missions: false } });
});

test("empty strings mean unset (Vercel)", () => {
  assert.equal(parseEnv({ ANTHROPIC_API_KEY: "", DEAL_VERIFIER_KEY: "" }).ok, true);
});

test("mainnet and malformed values fail closed", () => {
  assert.equal(parseEnv({ DEAL_CLUSTER: "mainnet-beta" }).ok, false);
  assert.equal(parseEnv({ DEAL_RPC_URL: "https://api.mainnet-beta.solana.com" }).ok, false);
  assert.equal(parseEnv({ DEAL_VERIFIER_KEY: "[1,2,3]" }).ok, false);
  assert.equal(parseEnv({ DEAL_RPC_URL: "nope" }).ok, false);
});

test("requireEnv refuses a capability that is not configured", () => {
  const r = requireEnv(parseEnv({}), "verifier");
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.status, r.body.reason], [503, "NOT_CONFIGURED"]);
  assert.equal(requireEnv(parseEnv({ DEAL_VERIFIER_KEY: KEY }), "verifier").ok, true);
});

test("health never reveals secrets", () => {
  const out = JSON.stringify(health(parseEnv({ DEAL_VERIFIER_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant-secret-value" })));
  assert.doesNotMatch(out, /secret-value|\[0,1,2/);
  assert.match(out, /"verifier":true/);
});
