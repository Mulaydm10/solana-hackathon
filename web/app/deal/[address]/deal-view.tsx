"use client";
// The deal as the chain shows it, and the one next step for the connected wallet. Release of a Data deal waits for
// "key received": the buyer has opened the data and checked it against the on-chain content hash (PLAN §4.2).
import { useCallback, useEffect, useState } from "react";
import { createNoopSigner, type Address, type Instruction } from "@solana/kit";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { formatAmount } from "@deal/core";
import { useWallet } from "../../wallet";
import { sendWithWallet } from "../../../lib/wallet-tx";
import { signWithWallet } from "../../../lib/wallet-sign";
import { PUBLIC_RPC } from "../../../lib/public-config";
import { readDealView, rpcFor, type DealView as View } from "../../../lib/deal-read";
import { acceptIx, deliverIx } from "../../../lib/buy-flow";
import { challengeIx, releaseIx } from "../../../lib/mission-flow";
import { ephemeralKeyPair, keyRequestMessage, openSealed } from "../../../lib/key-open";

const CLUSTER = process.env.NEXT_PUBLIC_DEAL_CLUSTER ?? "devnet";
const usdc = (base: string) => `${formatAmount(BigInt(base), 6)} USDC`;
const when = (t: number) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");
const receivedKey = (deal: string) => `deal-key-received:${deal}`;

function readReceived(deal: string): boolean {
  try {
    return localStorage.getItem(receivedKey(deal)) === "1";
  } catch {
    return false;
  }
}

export function DealView({ deal }: { deal: string }) {
  const connected = useWallet();
  const [view, setView] = useState<View | null | undefined>(undefined);
  const [received, setReceived] = useState(false);
  const [hashInput, setHashInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setView(await readDealView(rpcFor(PUBLIC_RPC), deal).catch(() => null));
  }, [deal]);
  useEffect(() => {
    void load();
    setReceived(readReceived(deal));
  }, [deal, load]);

  if (view === undefined) return <p className="loading-note">Reading the deal from chain<span className="dots"><i /><i /><i /></span></p>;
  if (view === null) return <p data-testid="deal-missing" className="empty-note">No deal at this address on devnet.</p>;

  const me = connected?.account.address ?? null;
  const role = me === view.buyer ? "buyer" : me === view.seller ? "seller" : null;
  const isData = view.expectedDeliveryHash !== "";
  const signer = me ? createNoopSigner(me as Address) : null;

  async function send(build: () => Promise<{ ok: true; ix: Instruction } | { ok: false; message: string }>, done: string) {
    setMsg(null);
    const r = await build();
    if (!r.ok) return setMsg(r.message);
    setBusy(true);
    const s = await sendWithWallet(connected!.wallet, connected!.account, PUBLIC_RPC, [r.ix]);
    setBusy(false);
    if (!s.ok) return setMsg(`Not sent: ${s.message}`);
    setMsg(`${done} Transaction ${s.signature.slice(0, 12)}…`);
    await load();
  }

  async function getData() {
    setMsg(null);
    setBusy(true);
    try {
      // A one-time key for this page only; the wallet signs a request naming it, this deal, the cluster and program.
      const e = ephemeralKeyPair();
      const expires = Math.floor(Date.now() / 1000) + 300;
      const message = keyRequestMessage({ cluster: CLUSTER, programId: DEAL_ESCROW_PROGRAM_ADDRESS, deal, ephemeralPub: e.pubHex, expires });
      const sig = await signWithWallet(connected!.wallet, connected!.account, message);
      if (!sig.ok) return setMsg(`Not signed: ${sig.message}`);
      const r = await fetch(`/api/deals/${deal}/key`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyer: me, ephemeralPub: e.pubHex, expires, signature: Array.from(sig.signature, (b) => b.toString(16).padStart(2, "0")).join("") }),
      });
      const body = (await r.json()) as { ok: boolean; sealedKey?: string; ciphertext?: string; reason?: string; message?: string };
      if (!body.ok) return setMsg(`Refused: ${body.reason}${body.message ? ` (${body.message})` : ""}`);
      const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      // The content hash comes from the chain (the deal's DealLink), never from the server's answer.
      const opened = await openSealed(e.secret, b64(body.sealedKey!), b64(body.ciphertext!), { buyer: view!.buyer, contentHashHex: view!.expectedDeliveryHash });
      if (!opened.ok) return setMsg(`The data did not check out: ${opened.message}. Do not release; challenge instead.`);
      const url = URL.createObjectURL(new Blob([new Uint8Array(opened.data)]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `deal-${deal.slice(0, 8)}.bin`;
      a.click();
      URL.revokeObjectURL(url);
      try {
        localStorage.setItem(receivedKey(deal), "1");
      } catch {
        // private mode: the indicator lasts for this page only
      }
      setReceived(true);
      setMsg("Key received: the data matches the listing's on-chain content hash. You can release now.");
    } finally {
      setBusy(false);
    }
  }

  const fee = { deal: deal as Address, buyer: view.buyer as Address, seller: view.seller as Address, mint: view.mint as Address, status: view.status, deliveryHash: view.deliveryHash, listing: view.listing as Address | null };
  const delivered = view.status === "Delivered";
  const reviewEnds = view.deliveredAt ? view.deliveredAt + view.reviewSecs : 0;

  const track = dealTrack(view.status);
  return (
    <section className="deal">
      <header className="mission-head">
        <span className={`live-dot ${track.closed ? "is-closed" : ""}`} aria-hidden />
        <span className="eyebrow-mono">Escrow</span>
        <strong className="mission-state">{view.status}</strong>
        {role ? <span className="chip role-chip">you are the {role}</span> : null}
      </header>
      <ol className="stage-track flow-track" aria-label="Deal progress">
        {DEAL_STEPS.map((name, i) => {
          const state = i < track.at ? "done" : i === track.at ? track.state : "queued";
          return (
            <li key={name} className={`stage is-${state}`} style={{ animationDelay: `${i * 0.1}s` }}>
              <span className="stage-node">{state === "done" ? "✓" : i + 1}</span>
              <span className="stage-name">{i === DEAL_STEPS.length - 1 && track.end ? track.end : name}</span>
            </li>
          );
        })}
      </ol>
      <div className="deal-grid">
        <div className="escrow-figure">
          <span className="eyebrow-mono">Price in escrow</span>
          <strong>{usdc(view.amount)}</strong>
          <span className="fine">Held by the escrow program, not by this site.</span>
        </div>
        <dl data-testid="deal-facts">
          <dt>Status</dt><dd data-testid="deal-status">{view.status}</dd>
          <dt>Price in escrow</dt><dd>{usdc(view.amount)}</dd>
          <dt>Deliver by</dt><dd>{when(view.deadline)}</dd>
          {view.deliveredAt ? (<><dt>Review until</dt><dd>{when(reviewEnds)}</dd></>) : null}
          <dt>Listing</dt><dd>{view.listing ? <a href={`/listing/${view.listing}`}>{view.listing}</a> : "none (a plain deal)"}</dd>
          {isData ? (<><dt>Key received</dt><dd data-testid="key-received" className={received ? "is-yes" : undefined}>{received ? "yes: checked against the on-chain content hash" : "not yet"}</dd></>) : null}
        </dl>
      </div>

      <div className="next-step">
        <span className="eyebrow-mono">Your next step{role ? ` · ${role}` : ""}</span>
        {!connected ? <p>Connect your wallet to act on this deal.</p> : null}
        {connected && !role ? <p>Your wallet is neither the buyer nor the seller of this deal.</p> : null}
        {connected && role && !nextStep(role, view.status) ? <p>Nothing to sign right now.</p> : null}

        {role === "seller" && view.status === "Open" ? (
          <button type="button" className="btn" data-magnet disabled={busy} onClick={() => send(() => acceptIx(signer!, view), "Accepted.")}>Accept the deal</button>
        ) : null}
        {role === "seller" && view.status === "Funded" ? (
          <div className="action-row">
            {isData ? (
              <p>Deliver: the program accepts only the listing&apos;s content hash, and custody then gives the buyer the key.</p>
            ) : (
              <label>sha256 of what you delivered <input value={hashInput} onChange={(e) => setHashInput(e.target.value.trim())} /></label>
            )}{" "}
            <button type="button" className="btn" data-magnet disabled={busy} onClick={() => send(() => deliverIx(signer!, view, hashInput), "Delivered.")}>Deliver in wallet</button>
          </div>
        ) : null}

        {role === "buyer" && delivered ? (
          <div className="action-row">
            {isData ? <button type="button" className="btn-ghost" data-magnet disabled={busy} onClick={getData}>Get the data</button> : null}{" "}
            <button
              type="button"
              className="btn"
              data-magnet
              data-testid="release"
              disabled={busy || (isData && !received)}
              title={isData && !received ? "Get the data and check it first" : undefined}
              onClick={() => send(() => releaseIx(signer!, fee, view.deliveryHash), "Released: the seller is paid.")}
            >
              Release payment
            </button>{" "}
            <button type="button" className="btn-revoke" disabled={busy} onClick={() => send(() => challengeIx(signer!, fee), "Challenged: the verifier decides.")}>Challenge</button>
          </div>
        ) : null}
      </div>

      {msg ? <p role="status">{msg}</p> : null}
    </section>
  );
}

const DEAL_STEPS = ["Opened", "Accepted", "Delivered", "Settled"];
const SETTLED_OK = ["Released", "Claimed", "VerifiedPass"];

/** Where a deal status sits on the four-step track (display only). */
function dealTrack(status: string): { at: number; state: string; closed: boolean; end?: string } {
  if (status === "Open") return { at: 1, state: "waiting", closed: false };
  if (status === "Funded") return { at: 2, state: "waiting", closed: false };
  if (status === "Delivered") return { at: 3, state: "waiting", closed: false };
  if (status === "Challenged") return { at: 3, state: "running", closed: false, end: "Challenged" };
  if (SETTLED_OK.includes(status)) return { at: 4, state: "done", closed: true, end: status === "VerifiedPass" ? "Settled by verifier" : status };
  return { at: 3, state: "declined", closed: true, end: status };
}

function nextStep(role: "buyer" | "seller", status: string): boolean {
  return role === "seller" ? status === "Open" || status === "Funded" : status === "Delivered";
}
