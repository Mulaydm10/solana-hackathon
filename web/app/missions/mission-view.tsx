"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createNoopSigner, type Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findMandatePda, getApproveStageInstructionAsync, getCloseMissionInstructionAsync, getRevokeMandateInstruction, policyAddress } from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { hexToBytes, PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";

type Event = { type: string; stage?: number; role?: string; ok?: boolean; reason?: string; amount?: string; payee?: string; output?: string; deliverableHash?: string };
type Status = {
  ok: boolean; reason?: string; state: string; mission: string; buyer: string; digest: string; events: Event[];
  roles: { role: string; agent: string }[]; plans: { stage: number; plan: string; planHash: string }[];
};

/** One line per event, written by code (worker output is quoted, never interpreted). */
export function describeEvent(e: Event): string {
  switch (e.type) {
    case "plan": return `Stage ${(e.stage ?? 0) + 1}: plan ready, waiting for your approval`;
    case "approved": return `Stage ${(e.stage ?? 0) + 1}: approved by you`;
    case "spend": return `${e.role} paid ${(Number(e.amount) / 1e6).toFixed(2)} USDC to ${e.payee?.slice(0, 6)}…: ${e.ok ? "settled on chain" : `refused by the chain (${e.reason})`}`;
    case "result": return `${e.role} reported: “${(e.output ?? "").slice(0, 200)}”`;
    case "refused": return `${e.role}: a request was refused (${e.reason})`;
    case "worker-exit": return `${e.role} finished`;
    case "delivered": return `Final product delivered, hash ${e.deliverableHash?.slice(0, 16)}…`;
    case "declined": return `Stage ${(e.stage ?? 0) + 1}: declined; the mission is closed`;
    case "failed": return `Stopped: ${e.reason}`;
    default: return e.type;
  }
}

export function MissionView() {
  const m = useSearchParams().get("m") ?? "";
  const connected = useWallet();
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) return;
    const r = await fetch(`/api/missions/${m}`, { cache: "no-store" });
    setS(await r.json());
  }, [m]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(build: (buyer: ReturnType<typeof createNoopSigner>) => Promise<Parameters<typeof sendWithWallet>[3]>) {
    setMsg(null);
    if (!connected) return setMsg("Connect the buyer's wallet first.");
    const r = await sendWithWallet(connected.wallet, connected.account, PUBLIC_RPC, await build(createNoopSigner(connected.account.address as Address)));
    setMsg(r.ok ? `Sent: ${r.signature.slice(0, 16)}…` : r.message);
    void load();
  }

  if (!m) return <p>Open a mission from the hire page, or add <code>?m=&lt;mission address&gt;</code>.</p>;
  if (!s) return <p>Loading…</p>;
  if (!s.ok) return <p role="alert">Not available: {s.reason}</p>;
  const approved = new Set(s.events.filter((e) => e.type === "approved").map((e) => e.stage));
  const next = s.plans.find((p) => !approved.has(p.stage));
  const prevDone = !next || next.stage === 0 || s.events.some((e) => e.type === "worker-exit");
  return (
    <section data-testid="mission-view">
      <p>Mission <code>{s.mission}</code>: <strong>{s.state}</strong></p>
      {next && s.state === "running" && prevDone && (
        <button type="button" onClick={() => void act(async (buyer) => [await getApproveStageInstructionAsync({
          buyer, mission: s.mission as Address, stage: next.stage, planHash: hexToBytes(next.planHash), mandatesDigest: hexToBytes(s.digest),
        })])}>Approve stage {next.stage + 1}&apos;s plan (wallet)</button>
      )}
      <h2>Agents</h2>
      <ul>{s.roles.map((r) => (
        <li key={r.agent}>{r.role} <code>{r.agent.slice(0, 6)}…</code>{" "}
          <button type="button" onClick={() => void act(async (buyer) => [getRevokeMandateInstruction({
            buyer, mission: s.mission as Address, mandate: (await findMandatePda({ mission: s.mission as Address, agent: r.agent as Address }))[0],
          })])}>Revoke (wallet)</button></li>
      ))}</ul>
      <button type="button" onClick={() => void act(async (buyer) => [await getCloseMissionInstructionAsync({
        actor: buyer, mission: s.mission as Address, buyer: s.buyer as Address, policy: await policyAddress(s.buyer as Address), mint: PUBLIC_MINT as Address,
        buyerToken: (await findAssociatedTokenPda({ owner: s.buyer as Address, mint: PUBLIC_MINT as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
      })])}>Close the mission and take back what is left (wallet)</button>
      <h2>Progress</h2>
      <ol data-testid="mission-events">{s.events.map((e, i) => <li key={i}>{describeEvent(e)}</li>)}</ol>
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
