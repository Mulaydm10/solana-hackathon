// Proves that the program deployed at the program id is byte-for-byte the binary committed in
// chain/program/deal_escrow.so, and reports who can upgrade it. Node-only (reads files).
//   node --import tsx scripts/verify-deployed.ts [rpcUrl]
// Exit 0 = match, 1 = mismatch or not deployed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "../src/index.ts";
import { PROGRAM_SO } from "../src/node.ts";

type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function rpcClient(url: string): Rpc {
  return async (method, params) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type DeployedReport = {
  program: string;
  programData: string | null;
  upgradeAuthority: string | null;
  localSha256: string;
  deployedSha256: string | null;
  matches: boolean;
  reason?: string;
};

/** Upgradeable-loader layouts: Program = [u32 tag=2][programdata pubkey]; ProgramData = [u32 tag=3][u64 slot][option<pubkey> authority] then the ELF, zero-padded. */
export async function verifyDeployed(rpc: Rpc, localSo = readFileSync(PROGRAM_SO)): Promise<DeployedReport> {
  const local = new Uint8Array(localSo);
  const base: DeployedReport = { program: DEAL_ESCROW_PROGRAM_ADDRESS, programData: null, upgradeAuthority: null, localSha256: sha256(local), deployedSha256: null, matches: false };
  const prog = await rpc("getAccountInfo", [DEAL_ESCROW_PROGRAM_ADDRESS, { encoding: "base64" }]);
  if (!prog?.value) return { ...base, reason: "program account not found" };
  const pd = Buffer.from(prog.value.data[0], "base64");
  if (pd.readUInt32LE(0) !== 2) return { ...base, reason: "not an upgradeable-loader program account" };
  const programData = getBase58Decoder().decode(pd.subarray(4, 36));
  const acc = await rpc("getAccountInfo", [programData, { encoding: "base64" }]);
  if (!acc?.value) return { ...base, programData, reason: "programdata account not found" };
  const data = Buffer.from(acc.value.data[0], "base64");
  const hasAuthority = data[12] === 1;
  const upgradeAuthority = hasAuthority ? getBase58Decoder().decode(data.subarray(13, 45)) : null;
  const elf = data.subarray(45, 45 + local.length);
  const padding = data.subarray(45 + local.length);
  const deployedSha256 = sha256(elf);
  const matches = deployedSha256 === base.localSha256 && padding.every((b) => b === 0);
  return { ...base, programData, upgradeAuthority, deployedSha256, matches, reason: matches ? undefined : "deployed bytes differ from the committed binary" };
}

/** Base58 tokens in markdown that look like addresses (32 bytes) or signatures (64 bytes). */
export function citedOnChainIds(markdown: string): { addresses: string[]; signatures: string[] } {
  const addresses = new Set<string>();
  const signatures = new Set<string>();
  for (const m of markdown.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,90}\b/g)) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(getBase58Encoder().encode(m[0]));
    } catch {
      continue;
    }
    if (bytes.length === 32) addresses.add(m[0]);
    else if (bytes.length === 64) signatures.add(m[0]);
  }
  return { addresses: [...addresses], signatures: [...signatures] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] ?? process.env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
  const r = await verifyDeployed(rpcClient(url));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.matches ? 0 : 1);
}
