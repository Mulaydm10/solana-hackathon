// demo:mission's setup checks (#202): env read and validated before anything is sent, each problem one line naming
// the variable to fix, and never a key or an RPC credential in the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  demoEnv, DEVNET_GENESIS, DEVNET_RPC, DEVNET_USDC, keypairFileProblem, MIN_LAMPORTS, preflight, readKeypairFile, safeUrl, type ClusterView,
} from "../scripts/demo-setup.ts";

const dir = mkdtempSync(join(tmpdir(), "demo-setup-"));
const defaults = { buyerPath: join(dir, "default-buyer.json"), store: join(dir, "missions") };
const secret = Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
const good = join(dir, "buyer.json");
writeFileSync(good, JSON.stringify(secret));
const ADDR = "CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV";
const errorsOf = (r: ReturnType<typeof demoEnv>) => (r.ok ? [] : r.errors);

test("demoEnv: defaults are devnet, Circle devnet USDC and the script's own paths", () => {
  const r = demoEnv({}, defaults);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { rpcUrl: DEVNET_RPC, buyerPath: defaults.buyerPath, buyerPathFromEnv: false, mint: DEVNET_USDC, verifier: null, store: defaults.store });
});

test("demoEnv: RPC URL and wallet paths come from env", () => {
  const store = join(dir, "store");
  const r = demoEnv({ DEAL_RPC_URL: " https://devnet.helius-rpc.com/?api-key=abc ", DEMO_BUYER: good, MISSION_STORE: store, DEAL_VERIFIER: ADDR }, defaults);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.rpcUrl, "https://devnet.helius-rpc.com/?api-key=abc");
  assert.equal(r.value.buyerPath, good);
  assert.equal(r.value.buyerPathFromEnv, true);
  assert.equal(r.value.store, store);
  assert.equal(r.value.verifier, ADDR);
});

test("demoEnv: every problem at once, each naming its variable", () => {
  const errors = errorsOf(demoEnv({ DEAL_RPC_URL: "devnet please", DEMO_BUYER: join(dir, "nope.json"), DEAL_MINT: "0xdead", DEAL_VERIFIER: "me" }, defaults));
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /^DEAL_RPC_URL is not an http\(s\) URL/);
  assert.match(errors[1]!, /^DEAL_MINT /);
  assert.match(errors[2]!, /^DEAL_VERIFIER /);
  assert.match(errors[3]!, /^DEMO_BUYER=.*nope\.json does not exist/);
  assert.match(errorsOf(demoEnv({ DEAL_RPC_URL: "https://api.mainnet-beta.solana.com" }, defaults))[0]!, /^DEAL_RPC_URL points at mainnet/);
  assert.match(errorsOf(demoEnv({ DEAL_RPC_URL: "ftp://x.example" }, defaults))[0]!, /http\(s\)/);
  const file = join(dir, "a-file");
  writeFileSync(file, "x");
  assert.match(errorsOf(demoEnv({ MISSION_STORE: file }, defaults))[0]!, /^MISSION_STORE=.* is not a directory/);
});

test("keypair files: shape is checked, the content never appears in a message", () => {
  assert.equal(keypairFileProblem(good), null);
  assert.deepEqual([...readKeypairFile(good)], secret);
  const cases: [string, string, RegExp][] = [
    ["notjson.json", "{" + secret.join(","), /not valid JSON/],
    ["short.json", JSON.stringify(secret.slice(0, 32)), /not a 64-byte keypair array/],
    ["big.json", JSON.stringify([...secret.slice(0, 63), 999]), /not a 64-byte keypair array/],
    ["phrase.json", JSON.stringify("word ".repeat(12)), /not a 64-byte keypair array/],
  ];
  for (const [name, content, why] of cases) {
    const path = join(dir, name);
    writeFileSync(path, content);
    const m = keypairFileProblem(path)!;
    assert.match(m, why);
    assert.match(m, /solana-keygen/);
    assert.ok(!m.includes(secret.slice(0, 8).join(",")) && !m.includes("word"), m);
    assert.throws(() => readKeypairFile(path), why);
  }
  const sub = join(dir, "a-dir");
  mkdirSync(sub);
  assert.match(keypairFileProblem(sub)!, /is not a file/);
});

test("safeUrl: an API key in the RPC URL is never printed", () => {
  assert.equal(safeUrl("https://api.devnet.solana.com"), "https://api.devnet.solana.com");
  assert.equal(safeUrl("https://devnet.helius-rpc.com/?api-key=SECRET"), "https://devnet.helius-rpc.com (query/credentials hidden)");
  assert.ok(!safeUrl("https://user:SECRET@rpc.example/devnet").includes("SECRET"));
  assert.equal(safeUrl("not a url"), "(not a URL)");
});

const usdc = (v: bigint) => `${v} units`;
const params = { rpcUrl: "https://rpc.example/?api-key=SECRET", program: ADDR, mint: DEVNET_USDC, buyer: ADDR, needUsdc: 5_000_000n, usdc };
const cluster = (o: Partial<ClusterView> = {}): ClusterView => ({
  genesisHash: async () => DEVNET_GENESIS, executable: async () => true, exists: async () => true,
  lamports: async () => MIN_LAMPORTS, tokenBalance: async () => 5_000_000n, ...o,
});

test("preflight: a funded buyer on devnet passes", async () => {
  assert.deepEqual(await preflight(cluster(), params), []);
});

test("preflight: unreachable or non-devnet RPC is one clear line, without the URL's key", async () => {
  const down = await preflight(cluster({ genesisHash: async () => { throw new Error("fetch failed for https://rpc.example/?api-key=SECRET"); } }), params);
  assert.equal(down.length, 1);
  assert.match(down[0]!, /^Cannot reach DEAL_RPC_URL \(https:\/\/rpc\.example \(query\/credentials hidden\)\)/);
  assert.ok(!down[0]!.includes("SECRET"), down[0]);
  const mainnet = await preflight(cluster({ genesisHash: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }), params);
  assert.match(mainnet[0]!, /is not Solana devnet/);
  assert.ok(!mainnet[0]!.includes("SECRET"));
});

test("preflight: missing program, missing mint, no SOL and no USDC are all reported with the fix", async () => {
  const errors = await preflight(cluster({ executable: async () => null, exists: async () => false, lamports: async () => 0n, tokenBalance: async () => 1n }), params);
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /deal_escrow program .* is not deployed/);
  assert.match(errors[1]!, /^DEAL_MINT .* does not exist on devnet/);
  assert.match(errors[2]!, /has 0 SOL; it needs at least 0\.05 .*faucet\.solana\.com/);
  assert.match(errors[3]!, /holds 1 units; it needs 5000000 units .*faucet\.circle\.com/);
});
