// /missions shows what the chain says (#145): a revoked mandate is shown as revoked (no Revoke button), and a closed
// mission as closed (no Close button), even while the mission service still reports "done".
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { findMandatePda } from "@deal/chain";
import { missionState, readChainState, type ChainReads } from "../app/missions/chain-state.ts";

test("chain state: closed missions and revoked mandates are read per agent", async () => {
  const [m, a1, a2, a3] = await Promise.all([0, 1, 2, 3].map(async () => (await generateKeyPairSigner()).address));
  const revokedPda = (await findMandatePda({ mission: m!, agent: a1! }))[0];
  const livePda = (await findMandatePda({ mission: m!, agent: a2! }))[0];
  const reads = (closed: boolean): ChainReads => ({
    mission: async (a: Address) => (a === m ? { exists: true as const, data: { closed } } : { exists: false as const }),
    mandate: async (a: Address) => (a === revokedPda ? { exists: true as const, data: { revoked: true } }
      : a === livePda ? { exists: true as const, data: { revoked: false } } : { exists: false as const }),
  });
  const open = await readChainState(reads(false), m!, [a1!, a2!, a3!]);
  assert.deepEqual(open, { closed: false, revoked: { [a1!]: true, [a2!]: false, [a3!]: false } });
  assert.equal(missionState("running", open), "running");

  const closed = await readChainState(reads(true), m!, []);
  assert.equal(missionState("done", closed), "closed");

  assert.equal(await readChainState(reads(false), a3!, []), null); // no such mission
  const broken: ChainReads = { mission: async () => { throw new Error("rpc down"); }, mandate: async () => ({ exists: false }) };
  assert.equal(await readChainState(broken, m!, [a1!]), null);
  assert.equal(missionState("done", null), "done");
});
