// On-chain proof checks against devnet. Off by default so CI stays offline; run with
//   DEAL_CHECK_DEVNET=1 npm test --prefix chain
// 1. the deployed program is byte-for-byte the committed binary;
// 2. every address and transaction signature cited in the repo's markdown exists on devnet (Batas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { citedOnChainIds, rpcClient, verifyDeployed } from "../scripts/verify-deployed.ts";

const ON = process.env.DEAL_CHECK_DEVNET === "1";
const rpc = rpcClient(process.env.DEAL_RPC_URL ?? "https://api.devnet.solana.com");
const REPO = new URL("../../", import.meta.url).pathname;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".") || f === "Analysis" || f === "target") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) markdownFiles(p, out);
    else if (f.endsWith(".md")) out.push(p);
  }
  return out;
}

test("offline: README id extraction finds addresses and signatures", () => {
  const md = "program `CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV` tx 3qC1kFBCnUgZkyYAqDKb49EYKBoB3jfyfPU2waTTw7uMaFCA9Bsjprt3tyBn1MuQxhSdd9EidPUQFbtwdzKTFJwH";
  const ids = citedOnChainIds(md);
  assert.deepEqual(ids.addresses, ["CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV"]);
  assert.equal(ids.signatures.length, 1);
});

test("devnet: deployed program is byte-for-byte the committed binary", { skip: !ON && "set DEAL_CHECK_DEVNET=1" }, async () => {
  const r = await verifyDeployed(rpc);
  assert.ok(r.matches, JSON.stringify(r, null, 2));
});

test("devnet: every address and signature cited in the repo's markdown exists", { skip: !ON && "set DEAL_CHECK_DEVNET=1" }, async () => {
  const missing: string[] = [];
  for (const file of markdownFiles(REPO)) {
    const { addresses, signatures } = citedOnChainIds(readFileSync(file, "utf8"));
    for (const a of addresses) {
      const r = await rpc("getAccountInfo", [a, { encoding: "base64" }]);
      if (!r?.value) missing.push(`${file.replace(REPO, "")}: account ${a}`);
    }
    for (const s of signatures) {
      const r = await rpc("getSignatureStatuses", [[s], { searchTransactionHistory: true }]);
      if (!r?.value?.[0]) missing.push(`${file.replace(REPO, "")}: tx ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});
