"use client";
// The /machines page body (#229): machine cards, the robot's rules (from chain), the two charge buttons, the per-charge
// timeline with links, and running totals. Every value comes from the status API; nothing is computed here.
import { useState } from "react";
import type { ChargeView } from "../../lib/machines";
import type { MachineStatus } from "../../lib/machines-status";
import { ChoiceReason, NetworkSections, v2Of } from "./machines-v2";

const SOLANA_TX = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const SOLANA_ADDR = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 8)}…`;
const when = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function TxLink({ href, text }: { href: string | null; text: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer"><code>{text}</code></a> : <code>{text}</code>;
}

/** Program refusals that mean "over the robot's limit" (the mandate and policy checks). */
const LIMIT_REFUSALS = new Set(["OverPerTxCap", "OverMandateCap", "OverMissionBudget", "OverStageCap", "PayeeNotAllowed", "MandateExpired", "MandateRevoked", "OverMaxPrice", "OverPeriodBudget"]);
export function refusalText(c: ChargeView): string {
  const r = c.refused!.reason;
  return LIMIT_REFUSALS.has(r)
    ? `${c.amount} USDC is over the robot's limit: refused by the Solana program (${r}). Simulated only; nothing was sent, no money moved.`
    : `${c.amount} USDC charge refused in simulation before sending (${r}); nothing was sent, no money moved.`;
}

/** Refused attempts grouped by reason: one line each, so they never bury the settled charges. */
function RefusedSummary({ list }: { list: ChargeView[] }) {
  const groups = new Map<string, ChargeView[]>();
  for (const c of list) groups.set(c.refused!.reason, [...(groups.get(c.refused!.reason) ?? []), c]);
  return (
    <ol className="feed" data-testid="charge-refused">
      {[...groups].map(([reason, cs]) => {
        const at = cs.map((c) => c.at);
        const span = cs.length === 1 ? when(at[0]!) : `${when(Math.min(...at))} to ${when(Math.max(...at))}`;
        return <li key={reason} className="tone-crit"><span className="feed-tag">Refused</span><span>{cs.length === 1 ? refusalText(cs[0]!) : `${cs.length} attempts refused (${reason}), ${span}. ${LIMIT_REFUSALS.has(reason) ? "Over the robot's limit: refused by the Solana program." : "Refused in simulation before sending."} Nothing was sent, no money moved.`}{cs.length === 1 ? ` (${span})` : ""}</span></li>;
      })}
    </ol>
  );
}

function Timeline({ c, peaqTx }: { c: ChargeView; peaqTx: (h: string) => string | null }) {
  if (c.refused && !c.openSig) {
    return (
      <ol className="feed" data-testid="charge-refused">
        <li className="tone-crit"><span className="feed-tag">Refused</span><span>{refusalText(c)}</span></li>
      </ol>
    );
  }
  const rows: { tone: string; tag: string; body: React.ReactNode; done: boolean }[] = [
    { tone: "accent", tag: "Deal", done: !!c.openSig, body: <>Robot opened an escrow deal for {c.amount} USDC {c.openSig && <TxLink href={SOLANA_TX(c.openSig)} text={short(c.openSig)} />}</> },
    { tone: "idle", tag: "Meter", done: !!c.deliveryHash, body: <>Pad signed its meter reading: {c.kWh} kWh {c.deliveryHash && <>· hash <code>{c.deliveryHash.slice(0, 16)}…</code></>}</> },
    { tone: "idle", tag: "Delivered", done: !!c.deliverSig, body: <>Pad delivered the reading&apos;s hash on chain {c.deliverSig && <TxLink href={SOLANA_TX(c.deliverSig)} text={short(c.deliverSig)} />}</> },
    { tone: "ok", tag: "Released", done: !!c.releaseSig, body: <>Robot released exactly that reading: the pad is paid {c.releaseSig && <TxLink href={SOLANA_TX(c.releaseSig)} text={short(c.releaseSig)} />}</> },
    { tone: "accent", tag: "peaq", done: !!c.padEventTx, body: <>Revenue event for the pad {c.padEventTx && <TxLink href={peaqTx(c.padEventTx)} text={short(c.padEventTx)} />}</> },
    { tone: "accent", tag: "peaq", done: !!c.robotEventTx, body: <>Activity event for the robot {c.robotEventTx && <TxLink href={peaqTx(c.robotEventTx)} text={short(c.robotEventTx)} />}</> },
  ];
  return (
    <ol className="feed" data-testid="charge-timeline">
      {rows.map((r, i) => <li key={i} className={r.done ? `tone-${r.tone}` : "tone-idle"} style={r.done ? undefined : { opacity: 0.5 }}><span className="feed-tag">{r.tag}</span><span>{r.body}</span></li>)}
      {c.refused && <li className="tone-crit"><span className="feed-tag">Stopped</span><span>{c.refused.reason}: {c.refused.message}</span></li>}
    </ol>
  );
}

export function MachinesView({ initial }: { initial: MachineStatus }) {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const v2 = v2Of(s);
  const peaqTx = (h: string) => (s.explorerTx ? `${s.explorerTx}${h}` : null);

  async function run(amount: "0.40" | "0.60") {
    setBusy(amount);
    setMsg(null);
    try {
      const r = await fetch("/api/machines/charge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount }) });
      const j = (await r.json()) as { ok: boolean; message?: string };
      if (!j.ok) setMsg(j.message ?? "The charge could not run.");
      const st = (await (await fetch("/api/machines/status", { cache: "no-store" })).json()) as { ok: boolean } & MachineStatus;
      if (st.ok) setS(st);
    } catch {
      setMsg("The charge could not run. Try again shortly.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid="machines" className="mission">
      <ul className="agent-grid">{s.machines.map((m) => (
        <li key={m.role} className="agent-card" data-testid={`machine-${m.role}`}>
          <div className="agent-top">
            <span className="agent-avatar" aria-hidden>{m.role === "robot" ? "R" : "P"}</span>
            <div><strong className="agent-role">{m.name}</strong><a href={SOLANA_ADDR(m.wallet)} target="_blank" rel="noreferrer"><code>{short(m.wallet)}</code></a></div>
            <span className="agent-status">simulated machine</span>
          </div>
          <dl className="mandate">
            <dt>peaq machine ID</dt><dd><code>{m.machineId}</code></dd>
            <dt>peaq network</dt><dd>{s.deployment}</dd>
            <dt>Machine credit rating</dt><dd>{"status" in m.mcr ? `${m.mcr.status}${m.mcr.score !== undefined ? ` (${m.mcr.score})` : ""}` : "not served for testnet machines"}</dd>
          </dl>
        </li>
      ))}</ul>

      <h2>The owner&apos;s rules</h2>
      {s.rules ? (
        <div className="agent-card" data-testid="machine-rules">
          <span className="eyebrow-mono">Read from the robot&apos;s mandate on Solana devnet · {s.rules.live ? "live" : s.rules.revoked ? "revoked" : "expired"}</span>
          <dl className="mandate">
            <dt>Per charge</dt><dd>at most {s.rules.perTxCap} USDC</dd>
            <dt>Spent / cap</dt><dd>{s.rules.spent} / {s.rules.cap} USDC</dd>
            <dt>Allowed payee</dt><dd>{s.rules.payees.length === 1 && s.rules.payees[0] === s.machines[1]?.wallet ? "only this charging pad" : s.rules.payees.map(short).join(", ")}</dd>
            <dt>Expires</dt><dd>{when(s.rules.expiresAt)}</dd>
          </dl>
        </div>
      ) : <p className="fine">The robot&apos;s mandate could not be read from chain right now.</p>}

      <h2>The robot on its own</h2>
      <div className="agent-card" data-testid="robot-battery">
        <span className="eyebrow-mono">Simulated battery · updated {when(s.battery.updatedAt)}</span>
        <div className="meter" role="meter" aria-label="simulated battery" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.battery.levelPct}>
          <span style={{ width: `${s.battery.levelPct}%` }} />
        </div>
        <p className="fine">{s.battery.levelPct}% (simulated: it drains 3% per hour while idle and 15% per delivery; the battery and the driving are not real, the payments are)</p>
        {s.decisions[0] ? (
          <p data-testid="last-decision">
            Last decision: {s.decisions[0].action === "charge" ? `charge ${s.decisions[0].kWh} kWh for ${s.decisions[0].amount} USDC` : "wait"} · {s.decisions[0].by === "claude" ? "decided by Claude (from simulated telemetry)" : s.decisions[0].by === "simulated" ? "Simulated AI (fallback rule)" : "decided by the robot"} <span className="fine">({when(s.decisions[0].at)})</span>
          </p>
        ) : <p className="fine" data-testid="last-decision">No decision yet. The robot decides every 30 minutes.</p>}
        {s.decisions[0] && <p className="fine">{s.decisions[0].reason}</p>}
      </div>

      {v2 ? <NetworkSections s={s} v2={v2} peaqTx={peaqTx} /> : <p className="fine" data-testid="v2-not-configured">{s.v2.configured ? "The pad network could not be read right now, so only the single-pad demo is shown." : "The pad network is not configured on this deployment, so only the single-pad demo is shown."}</p>}

      <h2>Charge the robot</h2>
      <p>
        <button type="button" data-testid="charge-ok" disabled={!!busy || !s.rules?.live} onClick={() => void run("0.40")}>{busy === "0.40" ? "Charging…" : "Charge 0.40 USDC"}</button>
        <button type="button" data-testid="charge-over" className="btn-ghost" disabled={!!busy || !s.rules?.live} onClick={() => void run("0.60")}>{busy === "0.60" ? "Checking…" : "Try 0.60 USDC (over limit)"}</button>
      </p>
      <p className="fine">The over-limit charge is simulated against the program and refused there; it is never sent and no money moves.</p>
      {msg && <p role="alert">{msg}</p>}

      <h2>Totals</h2>
      <dl className="mandate" data-testid="machine-totals">
        <dt>Settled charges (listed below)</dt><dd>{s.totals.charges}</dd>
        <dt>Energy</dt><dd>{s.totals.kWh} kWh</dd>
        <dt>Paid to the pads</dt><dd>{s.totals.usdc} USDC</dd>
        <dt>Refused before sending</dt><dd>{s.totals.refused}</dd>
        <dt>peaq events</dt><dd>{s.totals.peaqEvents}</dd>
      </dl>

      <h2>Charges</h2>
      {s.history.length === 0 && <p className="fine">No charges yet.</p>}
      {s.history.filter((c) => !(c.refused && !c.openSig)).map((c) => {
        const byLabel = c.by === "claude" ? "decided by Claude (from simulated telemetry)" : c.by === "simulated" ? "Simulated AI (fallback rule)" : c.by === "robot" ? "decided by the robot" : undefined;
        return (
          <article key={c.id} className="agent-card" data-testid="charge">
            <span className="eyebrow-mono">{when(c.at)} · {c.amount} USDC · {c.kWh} kWh{byLabel ? ` · ${byLabel}` : ""}</span>
            <ChoiceReason s={s} chargeId={c.id} />
            <Timeline c={c} peaqTx={peaqTx} />
          </article>
        );
      })}
      {s.history.some((c) => c.refused && !c.openSig) && <RefusedSummary list={s.history.filter((c) => c.refused && !c.openSig)} />}
      <p className="fine" data-testid="charge-history-note">
        Earlier, 7 to 10 Oct, the robot charged from one pad (A) under the one-pad missions{" "}
        <TxLink href={SOLANA_ADDR("7hTQTkkZ5hGrVvdsGXm3kqG4RB3u7LiN62WdmUDssYn6")} text="7hTQTkkZ…" /> (7 Oct) and{" "}
        <TxLink href={SOLANA_ADDR("3yVERanw5afVZJ1kctWBKd8CYywwDq4NZcQkDr9nshEN")} text="3yVERanw…" /> (8 to 10 Oct): 11 settled charges, 12.839 kWh, 4.11 USDC,
        22 peaq events; their cards rolled out of this list before it kept every settled charge. The refusals above (10 to 12 Oct) were caused by
        a bug in our server, not by the robot's limits: it built two signer objects for the robot, so every charge to pads B
        and C was refused in simulation. Fixed in{" "}
        <a href="https://github.com/Mulaydm10/solana-hackathon/pull/295" target="_blank" rel="noreferrer">#295</a>; nothing was sent.
      </p>
    </section>
  );
}
