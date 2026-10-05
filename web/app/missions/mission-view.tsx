"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createNoopSigner, createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeDeal, fetchMaybeDealLink, fetchMaybeMandate, findLinkPda, findMandatePda, getCloseMissionInstructionAsync, getRevokeMandateInstruction, policyAddress, STATUS_NAMES } from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { demoMissionLink, PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { approveStageIx, challengeIx, describePlan, planHashOk, releaseIx, waitingStage, type FeeDealState } from "../../lib/mission-flow";
import { listMissions, missionLink, type SavedMission } from "../../lib/inbox";
import { missionState, readChainState, rpcReads, type ChainState } from "./chain-state";

type Event = { type: string; stage?: number; role?: string; ok?: boolean; reason?: string; amount?: string; payee?: string; output?: string; deliverableHash?: string };
type Status = {
  ok: boolean; reason?: string; state: string; mission: string; buyer: string; digest: string; events: Event[]; aiProvider?: string;
  roles: { role: string; agent: string }[]; plans: { stage: number; plan: string; planHash: string }[];
};

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** How the mission's agent text was produced, as the mission service reports it (#191). Simulated runs always say so. */
export const aiLabel = (provider: string | undefined): string | null =>
  provider === "simulated" ? "Simulated AI demo" : provider === "anthropic" ? "AI: Claude" : null;
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

type MandateView = { cap: bigint; perTxCap: bigint; spent: bigint; payees: number; expiresAt: bigint };

/** Each agent's mandate as the chain holds it (cap, per-payment cap, spent, allowed payees, expiry). */
async function readMandates(mission: string, agents: readonly string[]): Promise<Record<string, MandateView>> {
  const rpc = createSolanaRpc(PUBLIC_RPC);
  const out: Record<string, MandateView> = {};
  await Promise.all(agents.map(async (agent) => {
    try {
      const md = await fetchMaybeMandate(rpc, (await findMandatePda({ mission: mission as Address, agent: agent as Address }))[0]);
      if (md.exists) out[agent] = { cap: md.data.cap, perTxCap: md.data.perTxCap, spent: md.data.spent, payees: md.data.payees.length, expiresAt: md.data.expiresAt };
    } catch { /* shown without its mandate */ }
  }));
  return out;
}

const usd = (v: bigint | string | undefined) => `${(Number(v ?? 0) / 1e6).toFixed(2)}`;
type StageState = "queued" | "waiting" | "running" | "done" | "declined";

/** Where each stage stands, from the mission's events. */
export function stageStates(events: readonly Event[], stages: readonly number[]): StageState[] {
  const has = (t: string, st: number) => events.some((e) => e.type === t && e.stage === st);
  const delivered = events.some((e) => e.type === "delivered");
  return stages.map((st) => {
    if (has("declined", st)) return "declined";
    if (has("approved", st)) return delivered || events.some((e) => e.type === "plan" && (e.stage ?? -1) > st) ? "done" : "running";
    return has("plan", st) ? "waiting" : "queued";
  });
}

const planRoles = (plan: string): string[] => {
  try { const r = (JSON.parse(plan) as { roles?: unknown }).roles; return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};
const planName = (plan: string, stage: number) => {
  try { const n = (JSON.parse(plan) as { name?: unknown }).name; return typeof n === "string" ? n : `Stage ${stage + 1}`; } catch { return `Stage ${stage + 1}`; }
};
const planCap = (plan: string) => {
  try { return usd(String((JSON.parse(plan) as { cap?: unknown }).cap ?? 0)); } catch { return "?"; }
};
const TAG: Record<string, string> = { plan: "Plan", approved: "Approved", result: "Result", refused: "Refused", "worker-exit": "Done", delivered: "Delivered", declined: "Declined", failed: "Stopped" };
const eventTone = (e: Event) => (e.type === "spend" ? (e.ok ? "ok" : "crit") : e.type === "refused" || e.type === "failed" || e.type === "declined" ? "crit" : e.type === "plan" ? "warn" : e.type === "delivered" || e.type === "approved" ? "accent" : "idle");

/** The approvals inbox: the missions this browser hired, each with what is waiting for the buyer. */
function Inbox() {
  const [saved, setSaved] = useState<SavedMission[]>([]);
  const [status, setStatus] = useState<Record<string, Status | null>>({});
  useEffect(() => {
    const ms = listMissions();
    setSaved(ms);
    void Promise.all(ms.map(async (m) => {
      const s = await fetch(`/api/missions/${m.mission}`, { cache: "no-store" }).then((r) => r.json() as Promise<Status>).catch(() => null);
      const chain = s?.ok ? await readChainState(rpcReads(createSolanaRpc(PUBLIC_RPC)), m.mission as Address, []) : null;
      setStatus((prev) => ({ ...prev, [m.mission]: s?.ok ? { ...s, state: missionState(s.state, chain) } : s }));
    }));
  }, []);
  if (saved.length === 0) {
    const demo = demoMissionLink();
    return (
      <p data-testid="inbox-empty">
        No missions hired from this browser yet. <a href="/hire">Hire a team</a>, or open a mission with <code>?m=&lt;mission address&gt;</code>.
        {demo ? <> Or <a href={demo} data-testid="demo-mission">watch the demo mission</a> (read-only, no wallet needed).</> : null}
      </p>
    );
  }
  return (
    <ul data-testid="inbox" className="inbox">
      {saved.map((m) => {
        const s = status[m.mission];
        const waiting = s?.ok ? waitingStage(s.events) : null;
        const delivered = s?.ok && s.events.some((e) => e.type === "delivered");
        return (
          <li key={m.mission} data-tilt>
            <a href={missionLink(m)}><code>{m.mission.slice(0, 8)}…</code></a>{" "}
            {s === undefined ? "loading…" : !s?.ok ? `not available (${s?.reason ?? "no answer"})`
              : s.state === "closed" ? "closed: what was left went back to you"
              : waiting !== null ? <strong>stage {waiting + 1} is waiting for your approval</strong>
              : delivered ? <strong>final product delivered: release or challenge</strong>
              : s.state}
            {s?.ok && aiLabel(s.aiProvider) ? <> · {aiLabel(s.aiProvider)}</> : null}
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
  // A demo mission (#183): the site's demo buyer signs on the server; the routes refuse missions it did not create.
  const demo = params.get("demo") === "1";
  const connected = useWallet();
  const [s, setS] = useState<Status | null>(null);
  const [deal, setDeal] = useState<FeeDealState | null>(null);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [mandates, setMandates] = useState<Record<string, MandateView>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ADDRESS.test(m)) return;
    const r = await fetch(`/api/missions/${m}`, { cache: "no-store" });
    const st = (await r.json()) as Status;
    setS(st);
    if (st.ok) {
      setChain(await readChainState(rpcReads(createSolanaRpc(PUBLIC_RPC)), m as Address, st.roles.map((x) => x.agent)));
      setMandates(await readMandates(m, st.roles.map((x) => x.agent)));
    }
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
  async function demoAct(path: string, body: unknown) {
    setMsg(null);
    const r = await fetch(`/api/demo/missions/${m}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as { ok?: boolean; signature?: string; reason?: string; message?: string };
    setMsg(b.ok ? `Sent by the demo buyer: ${String(b.signature).slice(0, 16)}…` : `Refused: ${b.reason}${b.message ? ` (${b.message})` : ""}`);
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
  const closed = chain?.closed === true;
  const stages = [...s.plans].sort((a, b) => a.stage - b.stage);
  const states = stageStates(s.events, stages.map((p) => p.stage));
  const runningRoles = new Set(stages.filter((_, i) => states[i] === "running").flatMap((p) => planRoles(p.plan)));
  const finalText = [...s.events].reverse().find((e) => e.type === "result" && e.role === "writer")?.output
    ?? [...s.events].reverse().find((e) => e.type === "result")?.output;
  const revokeIx = (agent: string) => act(async (buyer) => [getRevokeMandateInstruction({
    buyer, mission: s.mission as Address, mandate: (await findMandatePda({ mission: s.mission as Address, agent: agent as Address }))[0],
  })]);
  return (
    <section data-testid="mission-view" className="mission">
      <header className="mission-head">
        <span className={`live-dot ${closed ? "is-closed" : ""}`} aria-hidden />
        <span className="eyebrow-mono">Mission</span>
        <a href={explorer(s.mission)}><code>{s.mission.slice(0, 6)}…{s.mission.slice(-4)}</code></a>
        <strong className="mission-state">{missionState(s.state, chain)}</strong>
        {aiLabel(s.aiProvider) && <span data-testid="ai-provider" className="eyebrow-mono">{aiLabel(s.aiProvider)}</span>}
        {closed && <span> (you closed it; what was left went back to your wallet)</span>}
      </header>

      <ol className="stage-track" aria-label="Stages">
        {stages.map((p, i) => (
          <li key={p.stage} className={`stage is-${states[i]}`} style={{ animationDelay: `${i * 0.12}s` }}>
            <span className="stage-node">{states[i] === "done" ? "✓" : i + 1}</span>
            <span className="stage-name">{planName(p.plan, p.stage)}</span>
            <span className="stage-meta">{planRoles(p.plan).join(", ")} · cap {planCap(p.plan)} USDC</span>
            <span className="stage-status">{states[i] === "waiting" ? "waiting for you" : states[i]}</span>
          </li>
        ))}
        <li className={`stage is-${product ? "done" : "queued"}`} style={{ animationDelay: `${stages.length * 0.12}s` }}>
          <span className="stage-node">{product ? "✓" : "◆"}</span>
          <span className="stage-name">Final product</span>
          <span className="stage-meta">hash checked against the fee deal</span>
          <span className="stage-status">{product ? "delivered" : "not yet"}</span>
        </li>
      </ol>

      {plan && (
        <div data-testid="approval" className="approval-card">
          <span className="eyebrow-mono">Waiting for your approval</span>
          <h2>Stage {plan.stage + 1}: {planName(plan.plan, plan.stage)}</h2>
          <p>{describePlan(plan.plan)}. Plan hash <code>{plan.planHash.slice(0, 16)}…</code>
            {planHashOk(plan) ? <span className="hash-ok"> ✓ matches the plan shown</span> : <strong> does NOT match the plan shown: do not approve</strong>}</p>
          <p className="fine">Your signature is bound to this exact plan hash; a different plan cannot reuse it.</p>
          <button type="button" disabled={!planHashOk(plan)} onClick={() => void act((buyer) => one(approveStageIx(buyer, s.mission as Address, s.plans, plan.stage, s.digest)))}>
            Approve stage {plan.stage + 1}&apos;s plan (wallet)</button>
          {demo && <button type="button" data-testid="demo-approve" disabled={!planHashOk(plan)} onClick={() => void demoAct("approve", { stage: plan.stage })}>
            Approve as the demo buyer (devnet, server-signed)</button>}
        </div>
      )}

      <h2>Agents</h2>
      <ul className="agent-grid">{s.roles.map((r, i) => {
        const md = mandates[r.agent];
        const revoked = chain?.revoked[r.agent] === true;
        const pct = md && md.cap > 0n ? Math.min(100, Number((md.spent * 1000n) / md.cap) / 10) : 0;
        const spends = s.events.filter((e) => e.type === "spend" && e.role === r.role);
        const refused = s.events.filter((e) => (e.type === "spend" && e.role === r.role && !e.ok) || (e.type === "refused" && e.role === r.role));
        const status = revoked ? "revoked" : closed ? "closed" : runningRoles.has(r.role) ? "working" : s.events.some((e) => e.type === "worker-exit" && e.role === r.role) ? "finished" : "standing by";
        return (
          <li key={r.agent} className={`agent-card is-${status.replace(" ", "-")}`} style={{ animationDelay: `${i * 0.1}s` }}>
            <div className="agent-top">
              <span className="agent-avatar" aria-hidden>{r.role.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong className="agent-role">{r.role}</strong>
                <a href={explorer(r.agent)}><code>{r.agent.slice(0, 6)}…</code></a>
              </div>
              <span className="agent-status">{status === "working" ? <>working<span className="dots"><i /><i /><i /></span></> : status}</span>
            </div>
            <div className="agent-sandbox"><span>isolated sandbox</span><span>scoped capabilities · no secrets</span></div>
            {md ? (
              <>
                <div className="meter" aria-label={`spent ${usd(md.spent)} of ${usd(md.cap)} USDC`}>
                  <span style={{ width: `${pct}%` }} />
                </div>
                <dl className="mandate">
                  <dt>Spent / cap</dt><dd>{usd(md.spent)} / {usd(md.cap)} USDC</dd>
                  <dt>Per payment</dt><dd>{usd(md.perTxCap)} USDC</dd>
                  <dt>Allowed payees</dt><dd>{md.payees === 0 ? "none" : md.payees}</dd>
                  <dt>Expires</dt><dd>{new Date(Number(md.expiresAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
                </dl>
              </>
            ) : <p className="fine">Mandate loading from chain…</p>}
            {spends.length > 0 && <p className="fine">{spends.length} payment attempt{spends.length > 1 ? "s" : ""}, {refused.length} refused by the chain</p>}
            {refused.length > 0 && <p className="stamp">Refused: {refused.at(-1)?.reason}</p>}
            {revoked ? <strong data-testid="revoked" className="revoked-stamp">revoked</strong> : !closed && (
              <button type="button" className="btn-revoke" onClick={() => void revokeIx(r.agent)}>Revoke (wallet)</button>
            )}
          </li>
        );
      })}</ul>

      {finalText && (
        <div className="final-product">
          <span className="eyebrow-mono">Final product{product ? <> · hash <code>{product.slice(0, 16)}…</code></> : null}</span>
          <pre>{finalText}</pre>
        </div>
      )}

      {closed ? <p data-testid="closed">This mission is closed.</p> : (
        <button type="button" className="btn-ghost-inline" onClick={() => void act(async (buyer) => [await getCloseMissionInstructionAsync({
          actor: buyer, mission: s.mission as Address, buyer: s.buyer as Address, policy: await policyAddress(s.buyer as Address), mint: PUBLIC_MINT as Address,
          buyerToken: (await findAssociatedTokenPda({ owner: s.buyer as Address, mint: PUBLIC_MINT as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
        })])}>Close the mission and take back what is left (wallet)</button>
      )}
      <h2>Team fee</h2>
      {!ADDRESS.test(fee) ? <p>No fee deal is linked to this mission.</p> : !deal ? <p>Fee deal <a href={explorer(fee)}><code>{fee.slice(0, 8)}…</code></a>: not readable yet.</p> : (
        <div data-testid="fee-deal">
          <p>Fee deal <a href={explorer(deal.deal)}><code>{deal.deal.slice(0, 8)}…</code></a>: <strong>{deal.status}</strong>
            {deal.status === "Delivered" && <> (delivered hash <code>{deal.deliveryHash.slice(0, 16)}…</code>{product ? (product === deal.deliveryHash ? ", the final product shown here" : ", NOT the final product shown here") : ""})</>}</p>
          {deal.status === "Delivered" && (
            <>
              <button type="button" disabled={!product || product !== deal.deliveryHash} onClick={() => void act((buyer) => one(releaseIx(buyer, deal, product ?? "")))}>
                Release the fee for this final product (wallet)</button>{" "}
              {demo && <button type="button" data-testid="demo-release" disabled={!product || product !== deal.deliveryHash} onClick={() => void demoAct("release", { feeDeal: deal.deal })}>
                Release as the demo buyer</button>}{" "}
              <button type="button" onClick={() => void act((buyer) => one(challengeIx(buyer, deal)))}>Challenge it; the verifier rules (wallet)</button>
            </>
          )}
        </div>
      )}
      <h2>Progress</h2>
      <ol data-testid="mission-events" className="feed">{s.events.map((e, i) => (
        <li key={i} className={`tone-${eventTone(e)}`}>
          <span className="feed-tag">{e.type === "spend" ? (e.ok ? "Settled" : "Refused") : TAG[e.type] ?? e.type}</span>
          <span>{describeEvent(e)}</span>
        </li>
      ))}</ol>
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
