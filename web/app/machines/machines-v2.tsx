// The /machines v2 sections (#274): the pad network with MCR-style scores, insurance policies with their timelines, and
// the robot's earnings. Every value comes from the status API (#273); nothing is computed here except display order.
import type { MachineStatus } from "../../lib/machines-status";
import type { NetworkStatus } from "../../lib/machines-network-status";

export const SOLANA_TX = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 8)}…`;
const when = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export const SCORE_LABEL = "MCR-style score, computed by Fiducia from peaq events (peaq's own rating is not served on testnet)";

function Link({ href, text }: { href: string | null; text: string }) {
  return href ? <a href={href} target="_blank" rel="noreferrer"><code>{text}</code></a> : <code>{text}</code>;
}

/** The two strongest factors, plus the penalty when there is one. */
function topFactors(f: Record<string, number>): string {
  const strong = Object.entries(f).filter(([k, v]) => k !== "penalty" && v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`);
  return [...strong, ...(f.penalty ? [`penalty ${f.penalty}`] : [])].join(" · ");
}

type Configured = Partial<Omit<NetworkStatus, "v2">> & Pick<NetworkStatus, "network" | "scores" | "insurance" | "earnings">;
/** The v2 data when the status carries it; null when the network is not configured (or could not be read). */
export function v2Of(s: MachineStatus): Configured | null {
  return s.v2.configured && s.network && s.scores && s.insurance && s.earnings ? (s as unknown as Configured) : null;
}

/** A step failure in plain words; the code stays visible for whoever debugs it. Every failed step is retried on the next tick. */
export function plainNote(reason: string): string {
  const m = /^(open|accept|premium|claim|challenge|payout|refund|peaq outage event): (.+)$/.exec(reason);
  if (!m) return reason;
  const what: Record<string, string> = {
    open: "the insurer could not open the policy", accept: "the pad could not accept the policy",
    premium: "the pad could not pay the premium yet", claim: "the pad could not file its claim",
    challenge: "the insurer could not send its challenge", payout: "the payout could not be claimed yet",
    refund: "the unused cover could not be refunded yet", "peaq outage event": "the outage event could not be written to peaq yet",
  };
  return `${what[m[1]!]} (${m[2]}); retried on the next tick`;
}

function Policy({ p, padName, peaqTx }: { p: NetworkStatus["insurance"]["policies"][number]; padName: string; peaqTx: (h: string) => string | null }) {
  const rows: { tone: string; tag: string; done: boolean; body: React.ReactNode }[] = [
    { tone: "accent", tag: "Open", done: !!p.openSig, body: <>Insurer opened the policy {p.openSig && <Link href={SOLANA_TX(p.openSig)} text={short(p.openSig)} />}</> },
    { tone: "accent", tag: "Premium", done: !!p.premiumSig, body: <>Premium of {p.premium} USDC paid {p.premiumSig && <Link href={SOLANA_TX(p.premiumSig)} text={short(p.premiumSig)} />}</> },
  ];
  if (p.outage) {
    rows.push({ tone: "crit", tag: "Outage", done: true, body: <>Simulated outage: {p.outage.gapSecs} s without a heartbeat · recorded on peaq {p.outage.peaqEventTx ? <Link href={peaqTx(p.outage.peaqEventTx)} text={short(p.outage.peaqEventTx)} /> : <span className="fine">(event pending)</span>}</> });
    rows.push({ tone: p.outage.insurerCheck === "invalid" ? "crit" : "ok", tag: "Insurer check", done: !!p.outage.insurerCheck, body: <>{p.outage.insurerCheck ? `The insurer's check of the outage proof: ${p.outage.insurerCheck}` : "The insurer has not checked the proof yet"}</> });
  }
  if (p.claimSig) rows.push({ tone: "accent", tag: "Claim", done: true, body: <>Claim filed <Link href={SOLANA_TX(p.claimSig)} text={short(p.claimSig)} /></> });
  if (p.challengeSig) rows.push({ tone: "crit", tag: "Challenge", done: true, body: <>The proof did not check out: the insurer challenged the claim and nothing is paid unless the verifier rules for the pad <Link href={SOLANA_TX(p.challengeSig)} text={short(p.challengeSig)} /></> });
  if (p.payoutSig) rows.push({ tone: "ok", tag: "Payout", done: true, body: <>Coverage of {p.coverage} USDC paid out <Link href={SOLANA_TX(p.payoutSig)} text={short(p.payoutSig)} /></> });
  if (p.refundSig) rows.push({ tone: "ok", tag: "Refund", done: true, body: <>No outage: the unused cover was refunded <Link href={SOLANA_TX(p.refundSig)} text={short(p.refundSig)} /></> });
  return (
    <article className="agent-card" data-testid="policy">
      <span className="eyebrow-mono">{padName} · {p.status} · {when(p.termStart)} to {when(p.termEnd)}</span>
      <dl className="mandate">
        <dt>Coverage</dt><dd>{p.coverage} USDC</dd>
        <dt>Premium</dt><dd>{p.premium} USDC, priced at grade {p.grade}</dd>
        {p.reason && <><dt>Note</dt><dd>{plainNote(p.reason)}</dd></>}
      </dl>
      <ol className="feed">
        {rows.map((r, i) => <li key={i} className={r.done ? `tone-${r.tone}` : "tone-idle"} style={r.done ? undefined : { opacity: 0.5 }}><span className="feed-tag">{r.tag}</span><span>{r.body}</span></li>)}
      </ol>
    </article>
  );
}

export function NetworkSections({ s, v2, peaqTx }: { s: MachineStatus; v2: Configured; peaqTx: (h: string) => string | null }) {
  const earn = v2.earnings;
  return (
    <>
      <h2>The network</h2>
      <p className="fine" data-testid="score-label">{SCORE_LABEL}. Heartbeats and outages are simulated; the peaq events behind the score are real.</p>
      <ul className="agent-grid" data-testid="network">{v2.network.map((n) => {
        const sc = v2.scores[n.role];
        return (
          <li key={n.role} className="agent-card" data-testid={`pad-${n.role}`}>
            <div className="agent-top">
              <span className="agent-avatar" aria-hidden>P</span>
              <div><strong className="agent-role" style={{ display: "block" }}>{n.name}</strong><code>peaq machine {n.machineId}</code></div>
              <span className="agent-status">{n.online ? "online (simulated)" : "offline (simulated)"}</span>
            </div>
            <dl className="mandate">
              <dt>Price</dt><dd>{n.pricePerKwh} USDC per kWh</dd>
              <dt>Grade</dt><dd>{n.provisioned ? "not scored yet" : `${n.grade} · score ${n.score}`}</dd>
              <dt>Top factors</dt><dd>{sc && !n.provisioned ? topFactors(sc.factors) || "none yet" : "none yet"}</dd>
              <dt>Uptime, 24 h</dt><dd>{n.upPct24h}% (simulated heartbeats)</dd>
              <dt>Last heartbeat</dt><dd>{n.lastHeartbeatAt ? when(n.lastHeartbeatAt) : "none yet"}</dd>
            </dl>
            {sc && <p className="fine">{sc.explain}</p>}
          </li>
        );
      })}</ul>

      <h2>Insurance</h2>
      <div data-testid="insurance">
        <p className="fine">Parametric cover for the robot against a pad outage. Outages are simulated; the premiums, claims and payouts are real devnet transactions.</p>
        {v2.insurance.policies.length === 0 ? <p className="fine">No policies yet.</p> : v2.insurance.policies.map((p) => <Policy key={p.id} p={p} padName={v2.network.find((n) => n.role === p.pad)?.name ?? p.pad} peaqTx={peaqTx} />)}
      </div>

      <h2>The robot&apos;s earnings</h2>
      <div className="agent-card" data-testid="earnings">
        <span className="eyebrow-mono">Simulated deliveries · paid on Solana devnet</span>
        <dl className="mandate">
          <dt>Deliveries</dt><dd>{earn.jobs}</dd>
          <dt>Earned</dt><dd>{earn.earned} USDC</dd>
          <dt>Spent on energy</dt><dd>{earn.spentOnEnergy} USDC</dd>
          <dt>Net</dt><dd>{earn.net} USDC</dd>
        </dl>
        {earn.recent.length === 0 ? <p className="fine">No deliveries yet.</p> : (
          <ol className="feed">{earn.recent.map((j) => (
            <li key={j.id} className="tone-ok"><span className="feed-tag">Job</span><span>
              {when(j.at)} · {j.amount} USDC (simulated delivery){" "}
              {j.releaseSig && <Link href={SOLANA_TX(j.releaseSig)} text={short(j.releaseSig)} />}{" "}
              {j.robotEventTx && <Link href={peaqTx(j.robotEventTx)} text={`peaq ${short(j.robotEventTx)}`} />}
            </span></li>
          ))}</ol>
        )}
      </div>
    </>
  );
}

/** "chose <pad> because …" for a charge, from the decision that made it. Null when there is no recorded choice. */
export function ChoiceReason({ s, chargeId }: { s: MachineStatus; chargeId: string }) {
  const d = s.decisions.find((x) => x.chargeId === chargeId && x.chosenPad);
  if (!d || !d.chosenPad) return null;
  const name = s.network?.find((n) => n.role === d.chosenPad)?.name ?? d.chosenPad;
  const by = d.choiceBy === "claude" ? "decided by Claude (from simulated telemetry)" : d.choiceBy === "simulated" ? "Simulated AI (fallback rule)" : "decided by the robot";
  return <p className="fine" data-testid="choice-reason">Chose {name} because {d.choiceReason ?? "no reason recorded"} · {by}</p>;
}
