// #211: the run's evidence lists every spend that landed on chain, and flags any the mission events missed.
import test from "node:test";
import assert from "node:assert/strict";
import { amountMoved, landedSpends, unreported, type AuditRpc } from "../scripts/spend-audit.ts";

const bal = (accountIndex: number, amount: string) => ({ accountIndex, uiTokenAmount: { amount } });

/** The devnet double spend, as the RPC returns it: two AgentSpend txs of 1 USDC on the researcher's mandate. */
function rpc(): AuditRpc {
  const txs: Record<string, { logs: string[]; pre: ReturnType<typeof bal>[]; post: ReturnType<typeof bal>[]; err?: unknown }> = {
    first: { logs: ["Program log: Instruction: AgentSpend"], pre: [bal(1, "4000000"), bal(2, "0")], post: [bal(1, "3000000"), bal(2, "1000000")] },
    second: { logs: ["Program log: Instruction: AgentSpend"], pre: [bal(1, "3000000"), bal(2, "1000000")], post: [bal(1, "2000000"), bal(2, "2000000")] },
    approve: { logs: ["Program log: Instruction: ApproveStage"], pre: [], post: [] },
    refused: { logs: ["Program log: Instruction: AgentSpend"], pre: [], post: [], err: { InstructionError: [0, { Custom: 6000 }] } },
  };
  return {
    getSignaturesForAddress: () => ({
      send: async () => [
        { signature: "second", slot: 507833888n, err: null },
        { signature: "first", slot: 507833887n, err: null },
        { signature: "approve", slot: 507833880n, err: null },
        { signature: "refused", slot: 507833886n, err: { InstructionError: [0, { Custom: 6000 }] } },
      ],
    }),
    getTransaction: (s: never) => ({
      send: async () => {
        const t = txs[s as unknown as string]!;
        return { meta: { err: t.err ?? null, logMessages: t.logs, preTokenBalances: t.pre, postTokenBalances: t.post } };
      },
    }),
  };
}

test("lists every AgentSpend that landed, in slot order, with its amount", async () => {
  const landed = await landedSpends(rpc(), ["mandate-researcher"]);
  assert.deepEqual(landed.map((s) => [s.signature, s.amount]), [["first", 1_000_000n], ["second", 1_000_000n]]);
});

test("flags the spend the mission events did not report (the #210 double payment)", async () => {
  const landed = await landedSpends(rpc(), ["mandate-researcher"]);
  assert.deepEqual(unreported(landed, ["second"]).map((s) => s.signature), ["first"]);
  assert.equal(unreported(landed, ["first", "second"]).length, 0);
});

test("amountMoved is the vault's payout", () => {
  assert.equal(amountMoved([bal(0, "5"), bal(1, "4000000")], [bal(0, "5"), bal(1, "2999999")]), 1_000_001n);
  assert.equal(amountMoved([], []), 0n);
});
