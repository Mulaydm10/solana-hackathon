"use client";
// The hire flow in the browser. Everything the buyer signs is built here from the program's generated builders
// and shown by its wallet; the server never holds the buyer's key.
import { useState } from "react";
import { createNoopSigner, createSolanaRpc, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchMaybeBuyerPolicy, findMandatePda, getAddMandateInstruction, getApproveStageInstructionAsync,
  getCreateMissionInstructionAsync, getInitPolicyInstructionAsync, policyAddress,
} from "@deal/chain";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { hexToBytes, PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";

export type TeamOption = { listing: string; name: string; description: string; roles: string[] };

/** create_mission's parameters as the service sends them (bigints and byte arrays as strings). */
type CreateWire = {
  missionId: string; budget: string; termsHash: string; stageCaps: string[]; expiresAt: string; verifier: string;
  minReviewSecs?: string; minResolveSecs?: string; maxToleranceBps?: number; maxBondBps?: number; minStakeBps?: number; rentLamports?: string;
};

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
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // A spending policy is required once per buyer; create a permissive one if missing (the mission's own
      // mandates and stage gates bound the agents).
      if (!(await fetchMaybeBuyerPolicy(rpc, await policyAddress(buyer.address))).exists) {
        await send([await getInitPolicyInstructionAsync({
          buyer, mint: PUBLIC_MINT as Address,
          params: { periodSecs: 86_400, periodBudget: 100_000_000n, maxPrice: 50_000_000n, approvalThreshold: 10n ** 15n, approver: buyer.address, allowAnySeller: true, allowedSellers: [] },
        })]);
      }
      const cp = prep.createParams;
      const [buyerToken] = await findAssociatedTokenPda({ owner: buyer.address, mint: PUBLIC_MINT as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      await send([await getCreateMissionInstructionAsync({
        buyer, mint: PUBLIC_MINT as Address, buyerToken,
        missionId: BigInt(cp.missionId), budget: BigInt(cp.budget), termsHash: hexToBytes(cp.termsHash), teamListing: team as Address,
        stageCaps: cp.stageCaps.map((x) => BigInt(x)), expiresAt: BigInt(cp.expiresAt), rentLamports: BigInt(cp.rentLamports ?? "50000000"),
        verifier: cp.verifier as Address, minReviewSecs: BigInt(cp.minReviewSecs ?? "600"), minResolveSecs: BigInt(cp.minResolveSecs ?? "600"),
        maxToleranceBps: Number(cp.maxToleranceBps ?? 500), maxBondBps: Number(cp.maxBondBps ?? 1000), minStakeBps: Number(cp.minStakeBps ?? 0),
      } as never)]);
      const mandates = await Promise.all(prep.roles.map(async (r) => {
        const [mandate] = await findMandatePda({ mission: prep.mission as Address, agent: r.agent as Address });
        const m = r.mandate;
        return getAddMandateInstruction({
          buyer, mission: prep.mission as Address, mandate, agent: m.agent as Address, roleHash: hexToBytes(m.roleHash), cap: BigInt(m.cap),
          perTxCap: BigInt(m.perTxCap), payees: m.payees as Address[], stageMask: m.stageMask, expiresAt: BigInt(m.expiresAt),
        });
      }));
      await send(mandates);
      await fetch(`/api/missions/${prep.mission}/start`, { method: "POST" });
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
      await send([await getApproveStageInstructionAsync({
        buyer: createNoopSigner(connected.account.address as Address), mission: prep.mission as Address, stage: 0,
        planHash: hexToBytes(prep.plans[0]!.planHash), mandatesDigest: hexToBytes(prep.digest),
      })]);
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
          <p>Mission <code>{prep.mission}</code>, terms hash <code>{prep.terms.hash.slice(0, 16)}…</code>, budget {usdc(prep.createParams.budget)}.</p>
          <table>
            <thead><tr><th>Agent role</th><th>Wallet</th><th>Cap</th><th>Per payment</th><th>Stages</th></tr></thead>
            <tbody>{prep.roles.map((r) => (
              <tr key={r.role}><td>{r.role}</td><td><code>{r.agent.slice(0, 6)}…</code></td><td>{usdc(r.mandate.cap)}</td><td>{usdc(r.mandate.perTxCap)}</td>
                <td>{prep.plans.filter((p) => (r.mandate.stageMask >> p.stage) & 1).map((p) => p.stage + 1).join(", ")}</td></tr>
            ))}</tbody>
          </table>
          <ol>{prep.plans.map((p) => <li key={p.stage}>Stage {p.stage + 1}: plan <code>{p.planHash.slice(0, 16)}…</code></li>)}</ol>
          {step === "review" && <button type="button" disabled={busy} onClick={() => void fund()}>Fund the mission and give the agents their mandates (wallet)</button>}
          {step === "funded" && <button type="button" disabled={busy} onClick={() => void approveFirst()}>Approve stage 1&apos;s plan (wallet)</button>}
          {step === "started" && <p>Stage 1 approved. Follow it on <a href={`/missions?m=${prep.mission}`}>your mission page</a>.</p>}
        </div>
      )}
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
