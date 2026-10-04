"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createNoopSigner, createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeDeal, fetchMaybeDealLink, findLinkPda, findMandatePda, getCloseMissionInstructionAsync, getRevokeMandateInstruction, policyAddress, STATUS_NAMES } from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { approveStageIx, challengeIx, describePlan, planHashOk, releaseIx, waitingStage, type FeeDealState } from "../../lib/mission-flow";
import { listMissions, missionLink, type SavedMission } from "../../lib/inbox";

type Event = { type: string; stage?: number; role?: string; ok?: boolean; reason?: string; amount?: string; payee?: string; output?: string; deliverableHash?: string };
type Status = {
  ok: boolean; reason?: string; state: string; mission: string; buyer: string; digest: string; events: Event[];
  roles: { role: string; agent: string }[]; plans: { stage: number; plan: string; planHash: string }[];
};

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

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

/** The team's fee deal as the chain shows it (null if there is none, or it cannot be read). */
async function readFeeDeal(deal: string): Promise<FeeDealState | null> {
  try {
    const rpc = createSolanaRpc(PUBLIC_RPC);
    const d = await fetchMaybeDeal(rpc, deal as Address);
    if (!d.exists) return null;
    const link = await fetchMaybeDealLink(rpc, (await findLinkPda({ deal: deal as Address }))[0]);
    return {
      deal: deal as Address, buyer: d.data.buyer, seller: d.data.seller, mint: d.data.mint, status: STATUS_NAMES[d.data.status] ?? "Unknown",
      deliveryHash: hex(d.data.deliveryHash), listing: link.exists ? link.data.listing : null,
    };
  } catch {
    return null;
  }
}

/** The approvals inbox: the missions this browser hired, each with what is waiting for the buyer. */
function Inbox() {
  const [saved, setSaved] = useState<SavedMission[]>([]);
  const [status, setStatus] = useState<Record<string, Status | null>>({});
  useEffect(() => {
    const ms = listMissions();
    setSaved(ms);
    void Promise.all(ms.map(async (m) => {
      const s = await fetch(`/api/missions/${m.mission}`, { cache: "no-store" }).then((r) => r.json() as Promise<Status>).catch(() => null);
      setStatus((prev) => ({ ...prev, [m.mission]: s }));
    }));
  }, []);
  if (saved.length === 0) return <p data-testid="inbox-empty">No missions hired from this browser yet. <a href="/hire">Hire a team</a>, or open a mission with <code>?m=&lt;mission address&gt;</code>.</p>;
  return (
    <ul data-testid="inbox">
      {saved.map((m) => {
        const s = status[m.mission];
        const waiting = s?.ok ? waitingStage(s.events) : null;
        const delivered = s?.ok && s.events.some((e) => e.type === "delivered");
        return (
          <li key={m.mission}>
            <a href={missionLink(m)}><code>{m.mission.slice(0, 8)}…</code></a>{" "}
            {s === undefined ? "loading…" : !s?.ok ? `not available (${s?.reason ?? "no answer"})`
              : waiting !== null ? <strong>stage {waiting + 1} is waiting for your approval</strong>
              : delivered ? <strong>final product delivered: release or challenge</strong>
              : s.state}
          </li>
        );
      })}
    </ul>
  );
}

export function MissionView() {
  const params = useSearchParams();
  const m = params.get("m") ?? "";
  const fee = params.get("fee") ?? (listMissions().find((x) => x.mission === m)?.feeDeal ?? "");
  const connected = useWallet();
  const [s, setS] = useState<Status | null>(null);
  const [deal, setDeal] = useState<FeeDealState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ADDRESS.test(m)) return;
    const r = await fetch(`/api/missions/${m}`, { cache: "no-store" });
    setS(await r.json());
    if (ADDRESS.test(fee)) setDeal(await readFeeDeal(fee));
  }, [m, fee]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(build: (buyer: ReturnType<typeof createNoopSigner>) => Promise<Instruction[] | { ok: false; message: string }>) {
    setMsg(null);
    if (!connected) return setMsg("Connect the buyer's wallet first.");
    const ixs = await build(createNoopSigner(connected.account.address as Address));
    if (!Array.isArray(ixs)) return setMsg(ixs.message);
    const r = await sendWithWallet(connected.wallet, connected.account, PUBLIC_RPC, ixs);
    setMsg(r.ok ? `Sent: ${r.signature.slice(0, 16)}…` : r.message);
    void load();
  }
  const one = async (p: Promise<{ ok: true; ix: Instruction } | { ok: false; message: string }>) => {
    const r = await p;
    return r.ok ? [r.ix] : r;
  };

  if (!m) return <Inbox />;
  if (!s) return <p>Loading…</p>;
  if (!s.ok) return <p role="alert">Not available: {s.reason}</p>;
  const waiting = waitingStage(s.events);
  const plan = waiting === null ? undefined : s.plans.find((p) => p.stage === waiting);
  const product = s.events.find((e) => e.type === "delivered")?.deliverableHash;
  return (
    <section data-testid="mission-view">
      <p>Mission <a href={explorer(s.mission)}><code>{s.mission}</code></a>: <strong>{s.state}</strong></p>
      {plan && (
        <div data-testid="approval">
          <h2>Waiting for your approval</h2>
          <p>Stage {plan.stage + 1}: {describePlan(plan.plan)}. Plan hash <code>{plan.planHash.slice(0, 16)}…</code>
            {planHashOk(plan) ? " (matches the plan shown)" : <strong> does NOT match the plan shown: do not approve</strong>}</p>
          <button type="button" disabled={!planHashOk(plan)} onClick={() => void act((buyer) => one(approveStageIx(buyer, s.mission as Address, s.plans, plan.stage, s.digest)))}>
            Approve stage {plan.stage + 1}&apos;s plan (wallet)</button>
        </div>
      )}
      <h2>Agents</h2>
      <ul>{s.roles.map((r) => (
        <li key={r.agent}>{r.role} <a href={explorer(r.agent)}><code>{r.agent.slice(0, 6)}…</code></a>{" "}
          <button type="button" onClick={() => void act(async (buyer) => [getRevokeMandateInstruction({
            buyer, mission: s.mission as Address, mandate: (await findMandatePda({ mission: s.mission as Address, agent: r.agent as Address }))[0],
          })])}>Revoke (wallet)</button></li>
      ))}</ul>
      <button type="button" onClick={() => void act(async (buyer) => [await getCloseMissionInstructionAsync({
        actor: buyer, mission: s.mission as Address, buyer: s.buyer as Address, policy: await policyAddress(s.buyer as Address), mint: PUBLIC_MINT as Address,
        buyerToken: (await findAssociatedTokenPda({ owner: s.buyer as Address, mint: PUBLIC_MINT as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
      })])}>Close the mission and take back what is left (wallet)</button>
      <h2>Team fee</h2>
      {!ADDRESS.test(fee) ? <p>No fee deal is linked to this mission.</p> : !deal ? <p>Fee deal <a href={explorer(fee)}><code>{fee.slice(0, 8)}…</code></a>: not readable yet.</p> : (
        <div data-testid="fee-deal">
          <p>Fee deal <a href={explorer(deal.deal)}><code>{deal.deal.slice(0, 8)}…</code></a>: <strong>{deal.status}</strong>
            {deal.status === "Delivered" && <> (delivered hash <code>{deal.deliveryHash.slice(0, 16)}…</code>{product ? (product === deal.deliveryHash ? ", the final product shown here" : ", NOT the final product shown here") : ""})</>}</p>
          {deal.status === "Delivered" && (
            <>
              <button type="button" disabled={!product || product !== deal.deliveryHash} onClick={() => void act((buyer) => one(releaseIx(buyer, deal, product ?? "")))}>
                Release the fee for this final product (wallet)</button>{" "}
              <button type="button" onClick={() => void act((buyer) => one(challengeIx(buyer, deal)))}>Challenge it; the verifier rules (wallet)</button>
            </>
          )}
        </div>
      )}
      <h2>Progress</h2>
      <ol data-testid="mission-events">{s.events.map((e, i) => <li key={i}>{describeEvent(e)}</li>)}</ol>
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
