// Every agent payment that actually LANDED on chain for a mission (#211). The run log and the mission events must
// agree with the chain: after the devnet double spend (#210) they showed one payment while the chain had two. This
// reads each mandate's transaction history back from the RPC and keeps the successful AgentSpend instructions.

export type LandedSpend = { signature: string; slot: number; mandate: string; amount: bigint };

/** The few RPC calls this needs (a @solana/kit Rpc satisfies it). */
export type AuditRpc = {
  getSignaturesForAddress(a: never, c: { limit: number; commitment: "confirmed" }): { send(): Promise<readonly { signature: string; slot: bigint | number; err: unknown }[]> };
  getTransaction(s: never, c: { commitment: "confirmed"; encoding: "json"; maxSupportedTransactionVersion: 0 }): {
    send(): Promise<{ meta: { err: unknown; logMessages?: readonly string[] | null; preTokenBalances?: readonly TokenBal[] | null; postTokenBalances?: readonly TokenBal[] | null } | null } | null>;
  };
};
type TokenBal = { accountIndex: number; uiTokenAmount: { amount: string } };

/** The amount moved by one transaction: the largest single token-balance decrease (the mission vault paying out). */
export function amountMoved(pre: readonly TokenBal[], post: readonly TokenBal[]): bigint {
  let best = 0n;
  for (const p of pre) {
    const q = post.find((x) => x.accountIndex === p.accountIndex);
    if (!q) continue;
    const d = BigInt(p.uiTokenAmount.amount) - BigInt(q.uiTokenAmount.amount);
    if (d > best) best = d;
  }
  return best;
}

export async function landedSpends(rpc: AuditRpc, mandates: readonly string[]): Promise<LandedSpend[]> {
  const out: LandedSpend[] = [];
  for (const mandate of mandates) {
    const sigs = await rpc.getSignaturesForAddress(mandate as never, { limit: 100, commitment: "confirmed" }).send();
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await rpc.getTransaction(s.signature as never, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
      const meta = tx?.meta;
      if (!meta || meta.err) continue;
      if (!(meta.logMessages ?? []).some((l) => l.includes("Instruction: AgentSpend"))) continue;
      out.push({ signature: s.signature, slot: Number(s.slot), mandate, amount: amountMoved(meta.preTokenBalances ?? [], meta.postTokenBalances ?? []) });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** Landed spends the mission events did not report (by signature). Empty = the evidence matches the chain. */
export function unreported(landed: readonly LandedSpend[], reportedSignatures: readonly string[]): LandedSpend[] {
  const seen = new Set(reportedSignatures);
  return landed.filter((s) => !seen.has(s.signature));
}
