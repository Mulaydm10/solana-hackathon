// The hire flow resumes after a failed wallet transaction (#141): it reads the chain first, never creates an existing
// mission again, and adds only the mandates still missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { findMandatePda, policyAddress } from "@deal/chain";
import { fundDone, fundError, missingMandates, readFundState, rpcExists } from "../app/hire/fund-steps.ts";

test("fund state: a funded mission whose mandates tx failed resumes with only the missing mandates", async () => {
  const [b, m, a1, a2] = await Promise.all([0, 1, 2, 3].map(async () => (await generateKeyPairSigner()).address));
  const roles = [{ role: "researcher", agent: a1! }, { role: "writer", agent: a2! }];
  const onChain = new Set<string>([await policyAddress(b!), m!]);
  const exists = async (a: Address) => onChain.has(a);

  const s = await readFundState(exists, b!, m!, roles.map((r) => r.agent));
  assert.deepEqual(s, { policy: true, mission: true, mandates: [false, false] });
  assert.deepEqual(missingMandates(roles, s), roles); // in the prepared order
  assert.equal(fundDone(s), false);

  onChain.add((await findMandatePda({ mission: m!, agent: a1! }))[0]);
  const s2 = await readFundState(exists, b!, m!, roles.map((r) => r.agent));
  assert.deepEqual(missingMandates(roles, s2), [roles[1]]);

  onChain.add((await findMandatePda({ mission: m!, agent: a2! }))[0]);
  assert.equal(fundDone(await readFundState(exists, b!, m!, roles.map((r) => r.agent))), true);

  const fresh = await readFundState(async () => false, b!, m!, roles.map((r) => r.agent));
  assert.deepEqual(fresh, { policy: false, mission: false, mandates: [false, false] });
});

test("rpcExists: an account exists when getAccountInfo returns a value", async () => {
  const rpc = { getAccountInfo: (a: Address) => ({ send: async () => ({ value: a === "x" ? { data: [] } : null }) }) };
  assert.equal(await rpcExists(rpc)("x" as Address), true);
  assert.equal(await rpcExists(rpc)("y" as Address), false);
});

test("fund errors say what is already paid and what a retry does", () => {
  assert.match(fundError("mandates", "Unexpected error"), /funded, but the agents' mandates were not added \(Unexpected error\).*only the missing mandates/);
  assert.match(fundError("mission", "rejected"), /Nothing was paid/);
  assert.match(fundError("policy", "rejected"), /Nothing was paid/);
});
