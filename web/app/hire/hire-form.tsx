"use client";
// The hire flow in the browser. Everything the buyer signs is built here from the program's generated builders
// and shown by its wallet; the server never holds the buyer's key.
import { useState } from "react";
import { createNoopSigner, createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import { fetchMaybeBuyerPolicy, findMandatePda, getAddMandateInstruction, getInitPolicyInstructionAsync, policyAddress, type BuyerPolicy } from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { approveStageIx, createMissionIx, describePlan, feeDealIx, hexToBytes, randomDealId, type CreateWire } from "../../lib/mission-flow";
import { missionLink, saveMission } from "../../lib/inbox";
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



export function HireForm({ teams }: { teams: TeamOption[] }) {
  const connected = useWallet();
  const [team, setTeam] = useState(teams[0]?.listing ?? "");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("10");
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [step, setStep] = useState<"form" | "review" | "funded" | "started">("form");
  const [feeDeal, setFeeDeal] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function fund() {
    if (!prep || !connected) return;
    setBusy(true);
    setMsg(null);
    try {
      const buyer = createNoopSigner(connected.account.address as Address);
      const rpc = createSolanaRpc(PUBLIC_RPC);
      const option = teams.find((t) => t.listing === team)!;
      // A spending policy is required once per buyer; if missing, it is created with the terms shown and edited above.
      if (!(await fetchMaybeBuyerPolicy(rpc, await policyAddress(buyer.address))).exists) {
        const pp = policyParams(policyForm, buyer.address, { budget: BigInt(prep.createParams.budget), fee: BigInt(option.price) },
          [option.seller, ...prep.roles.flatMap((r) => r.mandate.payees)]);
        if (!pp.ok) throw new Error(pp.message);
        await send([await getInitPolicyInstructionAsync({ buyer, mint: PUBLIC_MINT as Address, params: pp.params })]);
      }
      // The mission's budget and the team's fee deal in ONE transaction: both are funded, or neither is.
      const fee = await feeDealIx(buyer, {
        listing: { address: option.listing, seller: option.seller, price: BigInt(option.price), contentHash: option.contentHash },
        mint: PUBLIC_MINT as Address, termsHash: prep.terms.hash, verifier: prep.createParams.verifier as Address,
        deadline: BigInt(prep.createParams.expiresAt), dealId: randomDealId(),
      });
      await send([await createMissionIx(buyer, PUBLIC_MINT as Address, team as Address, prep.createParams), fee.ix]);
      setFeeDeal(fee.deal);
      saveMission({ mission: prep.mission, feeDeal: fee.deal, team, at: Date.now() });
      const mandates = await Promise.all(prep.roles.map(async (r) => {
        const [mandate] = await findMandatePda({ mission: prep.mission as Address, agent: r.agent as Address });
        const m = r.mandate;
        return getAddMandateInstruction({
          buyer, mission: prep.mission as Address, mandate, agent: m.agent as Address, roleHash: hexToBytes(m.roleHash), cap: BigInt(m.cap),
          perTxCap: BigInt(m.perTxCap), payees: m.payees as Address[], stageMask: m.stageMask, expiresAt: BigInt(m.expiresAt),
        });
      }));
      await send(mandates);
      await fetch(`/api/missions/${prep.mission}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feeDeal: fee.deal }) });
      setStep("funded");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
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

  if (teams.length === 0) return <p>No teams are listed yet.</p>;
  return (
    <section data-testid="hire-form">
      {step === "form" && (
        <form onSubmit={(e) => { e.preventDefault(); void prepare(); }}>
          <fieldset>
            <legend>Team</legend>
            {teams.map((t) => (
              <label key={t.listing} style={{ display: "block" }}>
                <input type="radio" name="team" value={t.listing} checked={team === t.listing} onChange={() => setTeam(t.listing)} /> {t.name}: &ldquo;{t.description}&rdquo; ({t.roles.join(", ")})
              </label>
            ))}
          </fieldset>
          <label style={{ display: "block" }}>Goal <textarea required minLength={3} maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} cols={60} /></label>
          <label style={{ display: "block" }}>Expense budget (USDC) <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} size={8} /></label>
          <button type="submit" disabled={busy}>Prepare the mission terms</button>
        </form>
      )}
      {prep && step !== "form" && (
        <div data-testid="mission-terms">
          <h2>Mission terms (rendered by code)</h2>
          <p>Mission <code>{prep.mission}</code>, terms hash <code>{prep.terms.hash.slice(0, 16)}…</code>, expense budget {usdc(prep.createParams.budget)},
            team fee {usdc(teams.find((t) => t.listing === team)?.price ?? "0")} in escrow until you release the final product.</p>
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
          <ol>{prep.plans.map((p) => <li key={p.stage}>Stage {p.stage + 1}: {describePlan(p.plan)}, plan <code>{p.planHash.slice(0, 16)}…</code></li>)}</ol>
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
                  <label style={{ display: "block" }}>Budget per day (USDC) <input inputMode="decimal" size={8} value={policyForm.perDay}
                    onChange={(e) => setPolicyForm({ ...policyForm, perDay: e.target.value })} /></label>
                  <label style={{ display: "block" }}>Max price per deal (USDC) <input inputMode="decimal" size={8} value={policyForm.maxPrice}
                    onChange={(e) => setPolicyForm({ ...policyForm, maxPrice: e.target.value })} /></label>
                  <label style={{ display: "block" }}><input type="checkbox" checked={policyForm.anySeller}
                    onChange={(e) => setPolicyForm({ ...policyForm, anySeller: e.target.checked })} /> Any seller (unchecked: only this team and the payees in its agents&apos; mandates)</label>
                </>
              )}
            </div>
          )}
          {step === "review" && <button type="button" disabled={busy} onClick={() => void fund()}>Fund the mission and the team fee, give the agents their mandates (wallet)</button>}
          {step === "funded" && <button type="button" disabled={busy} onClick={() => void approveFirst()}>Approve stage 1&apos;s plan (wallet)</button>}
          {step === "started" && <p>Stage 1 approved. Follow it on <a href={missionLink({ mission: prep.mission, feeDeal })}>your mission page</a>.</p>}
        </div>
      )}
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
