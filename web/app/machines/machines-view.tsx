"use client";
// The /machines page body (#229): machine cards, the robot's rules (from chain), the two charge buttons, the per-charge
// timeline with links, and running totals. Every value comes from the status API; nothing is computed here.
import { useState } from "react";
import type { ChargeView } from "../../lib/machines";
import type { MachineStatus } from "../../lib/machines-status";

const SOLANA_TX = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const SOLANA_ADDR = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 8)}…`;
const when = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function TxLink({ href, text }: { href: string | null; text: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer"><code>{text}</code></a> : <code>{text}</code>;
}

function Timeline({ c, peaqTx }: { c: ChargeView; peaqTx: (h: string) => string | null }) {
  if (c.refused && !c.openSig) {
    return (
      <ol className="feed" data-testid="charge-refused">
        <li className="tone-crit"><span className="feed-tag">Refused</span><span>{c.amount} USDC is over the robot&apos;s limit: refused by the Solana program ({c.refused.reason}). Simulated only; nothing was sent, no money moved.</span></li>
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
        <p className="fine">{s.battery.levelPct}% (simulated; the battery and the driving are not real, the payments are)</p>
        {s.decisions[0] ? (
          <p data-testid="last-decision">
            Last decision: {s.decisions[0].action === "charge" ? `charge ${s.decisions[0].kWh} kWh` : "wait"} — {s.decisions[0].reason} <span className="fine">({when(s.decisions[0].at)})</span>
          </p>
        ) : <p className="fine" data-testid="last-decision">No decision yet. The robot decides every 30 minutes.</p>}
      </div>

      <h2>Charge the robot</h2>
      <p>
        <button type="button" data-testid="charge-ok" disabled={!!busy || !s.rules?.live} onClick={() => void run("0.40")}>{busy === "0.40" ? "Charging…" : "Charge 0.40 USDC"}</button>
        <button type="button" data-testid="charge-over" className="btn-ghost" disabled={!!busy || !s.rules?.live} onClick={() => void run("0.60")}>{busy === "0.60" ? "Checking…" : "Try 0.60 USDC (over limit)"}</button>
      </p>
      <p className="fine">The over-limit charge is simulated against the program and refused there; it is never sent and no money moves.</p>
      {msg && <p role="alert">{msg}</p>}

      <h2>Totals</h2>
      <dl className="mandate" data-testid="machine-totals">
        <dt>Settled charges</dt><dd>{s.totals.charges}</dd>
        <dt>Energy</dt><dd>{s.totals.kWh} kWh</dd>
        <dt>Paid to the pad</dt><dd>{s.totals.usdc} USDC</dd>
        <dt>Refused by the program</dt><dd>{s.totals.refused}</dd>
        <dt>peaq events</dt><dd>{s.totals.peaqEvents}</dd>
      </dl>

      <h2>Charges</h2>
      {s.history.length === 0 ? <p className="fine">No charges yet.</p> : s.history.map((c) => (
        <article key={c.id} className="agent-card" data-testid="charge">
          <span className="eyebrow-mono">{when(c.at)} · {c.amount} USDC · {c.kWh} kWh{c.by === "robot" ? " · decided by the robot" : ""}</span>
          <Timeline c={c} peaqTx={peaqTx} />
        </article>
      ))}
    </section>
  );
}
