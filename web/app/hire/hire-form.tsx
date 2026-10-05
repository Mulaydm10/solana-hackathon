"use client";
// The hire flow in the browser. Everything the buyer signs is built here from the program's generated builders
// and shown by its wallet; the server never holds the buyer's key.
import type { HirePrefill } from "../../lib/hire-prefill";
import { useState } from "react";
import { createNoopSigner, createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import { fetchMaybeBuyerPolicy, findMandatePda, getAddMandateInstruction, getInitPolicyInstructionAsync, policyAddress, type BuyerPolicy } from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { approveStageIx, createMissionIx, describePlan, feeDealIx, hexToBytes, randomDealId, type CreateWire } from "../../lib/mission-flow";
import { listMissions, missionLink, saveMission } from "../../lib/inbox";
import { fundError, missingMandates, readFundState, rpcExists, type FundStep } from "./fund-steps";
import { DEFAULT_POLICY, policyParams, type PolicyForm } from "./policy-terms";

/** A Team listing as the hire page offers it; price in token base units as a decimal string. */
export type TeamOption = { listing: string; name: string; description: string; roles: string[]; seller: string; price: string; contentHash: string };

type Prepared = {
  mission: string; terms: { hash: string; canonical: string }; digest: string;
  createParams: CreateWire;
  roles: { role: string; agent: string; mandate: { agent: string; roleHash: string; cap: string; perTxCap: string; payees: string[]; stageMask: number; expiresAt: string } }[];
  plans: { stage: number; plan: string; planHash: string }[];
};

const usdc = (base: string) => `${(Number(base) / 1e6).toFixed(2)} USDC`;



export function HireForm({ teams, demo = false, initial = {} }: { teams: TeamOption[]; demo?: boolean; initial?: HirePrefill }) {
  const connected = useWallet();
  const [team, setTeam] = useState(initial.team ?? teams[0]?.listing ?? "");
  const [goal, setGoal] = useState(initial.goal ?? "");
  const [budget, setBudget] = useState(initial.budget ?? "10");
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [step, setStep] = useState<"form" | "review" | "funded" | "started">("form");
  const [feeDeal, setFeeDeal] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The buyer's budget policy on chain: undefined = not read yet, null = none (this hire creates it). */
  const [policy, setPolicy] = useState<BuyerPolicy | null | undefined>(undefined);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(DEFAULT_POLICY);

  async function send(ixs: Instruction[]) {
    if (!connected) throw new Error("connect your wallet first");
    const r = await sendWithWallet(connected.wallet, connected.account, PUBLIC_RPC, ixs);
    if (!r.ok) throw new Error(r.message);
    return r.signature;
  }

  async function prepare() {
    setMsg(null);
    if (!connected) return setMsg("Connect your devnet wallet first.");
    const base = Math.round(Number(budget) * 1e6);
    if (!Number.isFinite(base) || base <= 0) return setMsg("Enter a budget in USDC.");
    setBusy(true);
    try {
      const r = await fetch("/api/missions/prepare", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ team, goal, budget: String(base), buyer: connected.account.address }),
      });
      const body = await r.json();
      if (!body.ok) return setMsg(`Refused: ${body.reason}${body.message ? ` (${body.message})` : ""}`);
      setPrep(body);
      const p = await fetchMaybeBuyerPolicy(createSolanaRpc(PUBLIC_RPC), await policyAddress(connected.account.address as Address)).catch(() => undefined);
      setPolicy(p === undefined ? undefined : p.exists ? p.data : null);
      setStep("review");
    } finally {
      setBusy(false);
    }
  }

  /** Judges without a wallet: the site's devnet demo buyer hires the team (small fixed budget), then opens the mission. */
  async function tryDemo() {
    setMsg(null);
    setBusy(true);
    try {
      const r = await fetch("/api/demo/missions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }) });
      const body = (await r.json()) as { ok: boolean; mission?: string; feeDeal?: string; reason?: string; message?: string };
      if (!body.ok || !body.mission) return setMsg(`Demo refused: ${body.reason}${body.message ? ` (${body.message})` : ""}`);
      window.location.href = `/missions?m=${body.mission}&fee=${body.feeDeal ?? ""}&demo=1`;
    } catch {
      setMsg("The demo did not answer; try again.");
    } finally {
      setBusy(false);
    }
  }

  async function fund() {
    if (!prep || !connected) return;
    setBusy(true);
    setMsg(null);
    let stage: FundStep = "policy";
    try {
      const buyer = createNoopSigner(connected.account.address as Address);
      const rpc = createSolanaRpc(PUBLIC_RPC);
      // Read what is already on chain, so a retry resumes after a failed transaction instead of repeating one.
      const state = await readFundState(rpcExists(rpc), buyer.address, prep.mission as Address, prep.roles.map((r) => r.agent));
      const option = teams.find((t) => t.listing === team)!;
      // A spending policy is required once per buyer; if missing, it is created with the terms shown and edited above.
      if (!state.policy) {
        const pp = policyParams(policyForm, buyer.address, { budget: BigInt(prep.createParams.budget), fee: BigInt(option.price) },
          [option.seller, ...prep.roles.flatMap((r) => r.mandate.payees)]);
        if (!pp.ok) throw new Error(pp.message);
        await send([await getInitPolicyInstructionAsync({ buyer, mint: PUBLIC_MINT as Address, params: pp.params })]);
      }
      let deal = feeDeal ?? listMissions().find((x) => x.mission === prep.mission)?.feeDeal ?? null;
      if (!state.mission) {
        stage = "mission";
        // The mission's budget and the team's fee deal in ONE transaction: both are funded, or neither is.
        const fee = await feeDealIx(buyer, {
          listing: { address: option.listing, seller: option.seller, price: BigInt(option.price), contentHash: option.contentHash },
          mint: PUBLIC_MINT as Address, termsHash: prep.terms.hash, verifier: prep.createParams.verifier as Address,
          deadline: BigInt(prep.createParams.expiresAt), dealId: randomDealId(),
        });
        await send([await createMissionIx(buyer, PUBLIC_MINT as Address, team as Address, prep.createParams), fee.ix]);
        deal = fee.deal;
        setFeeDeal(fee.deal);
        saveMission({ mission: prep.mission, feeDeal: fee.deal, team, at: Date.now() });
      }
      const missing = missingMandates(prep.roles, state);
      if (missing.length > 0) {
        stage = "mandates";
        await send(await Promise.all(missing.map(async (r) => {
          const [mandate] = await findMandatePda({ mission: prep.mission as Address, agent: r.agent as Address });
          const m = r.mandate;
          return getAddMandateInstruction({
            buyer, mission: prep.mission as Address, mandate, agent: m.agent as Address, roleHash: hexToBytes(m.roleHash), cap: BigInt(m.cap),
            perTxCap: BigInt(m.perTxCap), payees: m.payees as Address[], stageMask: m.stageMask, expiresAt: BigInt(m.expiresAt),
          });
        })));
      }
      await fetch(`/api/missions/${prep.mission}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(deal ? { feeDeal: deal } : {}) });
      setFailed(false);
      setStep("funded");
    } catch (e) {
      setFailed(true);
      setMsg(fundError(stage, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function approveFirst() {
    if (!prep || !connected) return;
    setBusy(true);
    setMsg(null);
    try {
      // Built only if the plan shown hashes to the plan hash being approved (no approving A as B).
      const a = await approveStageIx(createNoopSigner(connected.account.address as Address), prep.mission as Address, prep.plans, 0, prep.digest);
      if (!a.ok) throw new Error(a.message);
      await send([a.ix]);
      setStep("started");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (teams.length === 0) return <p className="empty-note">No teams are listed yet.</p>;
  const option = teams.find((t) => t.listing === team);
  const at = step === "form" ? 0 : step === "review" ? 1 : step === "funded" ? 4 : 5;
  const FLOW = ["Mission terms", policy ? "Budget policy (on chain)" : "Budget policy", "Budget and team fee", "Agent mandates", "Approve stage 1"];
  return (
    <section data-testid="hire-form" className="hire">
      <ol className="stage-track flow-track" aria-label="Progress">
        {FLOW.map((name, i) => {
          const state = i < at || (i === 1 && policy && at >= 1) ? "done" : i === at ? (busy ? "running" : failed ? "declined" : "waiting") : "queued";
          return (
            <li key={name} className={`stage is-${state}`} style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="stage-node">{state === "done" ? "✓" : i + 1}</span>
              <span className="stage-name">{name}</span>
              <span className="stage-meta">{i === 0 ? "rendered by code" : "your wallet signs"}</span>
            </li>
          );
        })}
      </ol>
      {step === "form" && (
        <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void prepare(); }}>
          <div className="sheet-part">
            <span className="part-no">01</span>
            <fieldset className="team-set">
              <legend>Team</legend>
              {teams.map((t) => (
                <label key={t.listing} className="team-choice" data-tilt>
                  <input type="radio" name="team" value={t.listing} checked={team === t.listing} onChange={() => setTeam(t.listing)} />
                  <span className="team-body">
                    <span className="team-top"><strong className="team-name">{t.name}</strong><span className="chip chip-Team">Team</span></span>
                    <span className="team-desc">&ldquo;{t.description}&rdquo;</span>
                    <span className="team-roles">{t.roles.map((r) => <span key={r} className="role-pill"><span className="agent-avatar" aria-hidden>{r.slice(0, 1).toUpperCase()}</span>{r}</span>)}</span>
                    <span className="team-fee">team fee {usdc(t.price)} · held in escrow until you release the final product</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="sheet-part">
            <span className="part-no">02</span>
            <span className="eyebrow-mono">Your brief</span>
            <div className="field-grid brief-grid">
              <label className="span-2">Goal <textarea required minLength={3} maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} cols={60} placeholder="Plan 3 days in Lisbon for two, under 400 EUR" /></label>
              <label>Expense budget (USDC) <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} size={8} /></label>
              <p className="fine">The agents can only spend this budget, split into capped mandates. Unspent budget can be taken back.</p>
            </div>
          </div>
          <div className="sheet-actions">
            <button type="submit" className="btn" data-magnet disabled={busy}>Prepare the mission terms</button>
            <span className="fine">Nothing is signed yet: you review the terms first.</span>
            {demo && (
              <button type="button" data-testid="try-demo" className="btn-ghost-inline" disabled={busy} onClick={() => void tryDemo()}>
                Try the demo (no wallet: a capped devnet demo buyer signs)</button>
            )}
          </div>
        </form>
      )}
      {prep && step !== "form" && (
        <div data-testid="mission-terms" className="terms-sheet">
          <span className="eyebrow-mono">Mission terms · rendered by code</span>
          <h2>{option?.name ?? "Mission"}</h2>
          <div className="terms-figures">
            <div><span className="eyebrow-mono">Expense budget</span><strong className="figure-sm">{usdc(prep.createParams.budget)}</strong></div>
            <div><span className="eyebrow-mono">Team fee in escrow</span><strong className="figure-sm">{usdc(option?.price ?? "0")}</strong></div>
            <div><span className="eyebrow-mono">Terms hash</span><code>{prep.terms.hash.slice(0, 16)}…</code></div>
          </div>
          <p>Mission <code>{prep.mission}</code>. The team fee stays in escrow until you release the final product.</p>
          <table>
            <thead><tr><th>Agent role</th><th>Wallet</th><th>Cap</th><th>Per payment</th><th>Stages</th></tr></thead>
            <tbody>{prep.roles.map((r) => (
              <tr key={r.role}><td>{r.role}</td><td><code>{r.agent.slice(0, 6)}…</code></td><td>{usdc(r.mandate.cap)}</td><td>{usdc(r.mandate.perTxCap)}</td>
                <td>{prep.plans.filter((p) => (r.mandate.stageMask >> p.stage) & 1).map((p) => p.stage + 1).join(", ")}</td></tr>
            ))}</tbody>
          </table>
          <p data-testid="mission-expiry">Expires {new Date(Number(prep.createParams.expiresAt) * 1000).toUTCString()}: the team must deliver by then,
            and what is left of the budget can be taken back. Verifier <code>{prep.createParams.verifier}</code> rules on any challenge
            of the agents&apos; deals or the team fee.</p>
          <ol className="plan-list">{prep.plans.map((p) => <li key={p.stage}><span className="stage-node">{p.stage + 1}</span><span>Stage {p.stage + 1}: {describePlan(p.plan)}, plan <code>{p.planHash.slice(0, 16)}…</code></span></li>)}</ol>
          {step === "review" && (
            <div data-testid="policy-terms">
              <h3>Your budget policy</h3>
              {policy === undefined ? <p>Your budget policy could not be read yet; if you have none, it is created first with the terms below.</p> : null}
              {policy ? (
                <p>On chain: {usdc(policy.periodBudget.toString())} per {Number(policy.periodSecs) / 3_600} h, max price {usdc(policy.maxPrice.toString())} per deal,
                  {policy.allowAnySeller ? " any seller" : ` only ${policy.allowedSellers.length} listed seller(s)`}. This mission&apos;s agents inherit that seller rule.</p>
              ) : (
                <>
                  <p>You have no budget policy yet. Your wallet first signs one with these terms; every deal and mission you fund is checked against it,
                    and this mission&apos;s agents inherit its seller rule.</p>
                  <div className="field-grid">
                    <label>Budget per day (USDC) <input inputMode="decimal" size={8} value={policyForm.perDay}
                      onChange={(e) => setPolicyForm({ ...policyForm, perDay: e.target.value })} /></label>
                    <label>Max price per deal (USDC) <input inputMode="decimal" size={8} value={policyForm.maxPrice}
                      onChange={(e) => setPolicyForm({ ...policyForm, maxPrice: e.target.value })} /></label>
                  </div>
                  <label className="confirm"><input type="checkbox" checked={policyForm.anySeller}
                    onChange={(e) => setPolicyForm({ ...policyForm, anySeller: e.target.checked })} /> Any seller (unchecked: only this team and the payees in its agents&apos; mandates)</label>
                </>
              )}
            </div>
          )}
          {step === "review" && (
            <div className="sheet-actions">
              <button type="button" className="btn" data-magnet disabled={busy} onClick={() => void fund()}>
                {failed ? "Retry: send only what is still missing (wallet)" : "Fund the mission and the team fee, give the agents their mandates (wallet)"}</button>
              <span className="fine">Your wallet asks you to sign up to three transactions: your budget policy (only the first time), the mission
                budget with the team fee, then the agents&apos; mandates.</span>
            </div>
          )}
          {step === "funded" && <div className="sheet-actions"><button type="button" className="btn" data-magnet disabled={busy} onClick={() => void approveFirst()}>Approve stage 1&apos;s plan (wallet)</button></div>}
          {step === "started" && <p className="done-note">Stage 1 approved. Follow it on <a href={missionLink({ mission: prep.mission, feeDeal })}>your mission page</a>.</p>}
        </div>
      )}
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
