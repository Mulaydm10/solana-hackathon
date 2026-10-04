import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("defaults to devnet with the public RPC and no signer", () => {
  const r = loadConfig({});
  assert.deepEqual(r, { ok: true, config: { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com", keypairPath: null } });
});

test("localnet and a custom RPC are accepted", () => {
  const r = loadConfig({ DEAL_CLUSTER: "localnet", DEAL_RPC_URL: "http://127.0.0.1:9999", DEAL_KEYPAIR: "/tmp/k.json" });
  assert.equal(r.ok && r.config.rpcUrl, "http://127.0.0.1:9999");
  assert.equal(r.ok && r.config.keypairPath, "/tmp/k.json");
});

test("mainnet is refused (fail closed)", () => {
  assert.equal(loadConfig({ DEAL_CLUSTER: "mainnet-beta" }).ok, false);
  assert.equal(loadConfig({ DEAL_RPC_URL: "https://api.mainnet-beta.solana.com" }).ok, false);
});

test("malformed values are refused", () => {
  assert.equal(loadConfig({ DEAL_CLUSTER: "testnet" }).ok, false);
  assert.equal(loadConfig({ DEAL_RPC_URL: "not a url" }).ok, false);
  assert.equal(loadConfig({ DEAL_KEYPAIR: "" }).ok, false);
});
