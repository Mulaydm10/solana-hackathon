"use client";
// The sell flow in the browser (#110): upload or describe, watch the seller chain run on the server step by step,
// review grade, price and terms, then sign create_listing in your own wallet. After that the marketplace custody
// takes the data (checked against the on-chain content hash) and the marketplace assessor attests its own report.
import { useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import { useWallet } from "../wallet";
import { confirmSignature, sendWithWallet } from "../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { createListingIxs, MAX_UPLOAD_BYTES, readReply, reportLines, toBase64, tooLarge, type DraftedListing } from "../../lib/sell-tx";

type Step = { step: string; [k: string]: unknown };
type Draft = { ok: true; steps: Step[]; meta: Record<string, unknown>; needsConfirmation: boolean; listing: DraftedListing } | { ok: false; reason: string; message: string; steps?: Step[] };
type Source = { data?: string; service?: Record<string, unknown> };
/** A listing that is on chain (or being confirmed) but not yet in custody / attested: retried without a new transaction. */
type Pending = { listing: string; signature?: string; d: Extract<Draft, { ok: true }>; src: Source };

const usdc = (base: string) => `${(Number(base) / 1e6).toFixed(2)} USDC`;
const post = async (path: string, body: unknown) =>
  readReply(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** One line per seller-chain step, written by code (seller text is never interpreted). */
export function describeStep(s: Step): string {
  switch (s.step) {
    case "classify": return `Classified: ${s.kind}${s.format ? `, ${s.format}` : ""}${s.rows !== undefined ? `, ${s.rows} rows` : ""}`;
    case "assess": return `Assessed: grade ${s.grade}${s.needsConfirmation ? ", personal data found" : ""}`;
    case "price": return `Suggested price: ${usdc(String(s.low))} to ${usdc(String(s.high))} (middle ${usdc(String(s.mid))})`;
    case "draft": return `Terms drafted, hash ${String(s.termsHash).slice(0, 16)}…`;
    default: return s.step;
  }
}

export function SellForm() {
  const connected = useWallet();
  const [mode, setMode] = useState<"data" | "service">("data");
  const [file, setFile] = useState<File | null>(null);
  const [service, setService] = useState({ endpoint: "https://", input: "{\"type\":\"object\"}", output: "{\"type\":\"object\"}", example: "{}" });
  const [desc, setDesc] = useState({ name: "", description: "", category: "", tags: "" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shown, setShown] = useState(0);
  const [price, setPrice] = useState("");
  const [pii, setPii] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ listing: string; grade?: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [resumeAt, setResumeAt] = useState("");

  async function source(): Promise<Source> {
    if (mode === "data") {
      if (!file) throw new Error("choose a file");
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(tooLarge(file.size));
      return { data: toBase64(new Uint8Array(await file.arrayBuffer())) };
    }
    return { service: { endpoint: service.endpoint, input_schema: JSON.parse(service.input), output_schema: JSON.parse(service.output), example_input: JSON.parse(service.example) } };
  }

  async function run() {
    setMsg(null); setDraft(null); setShown(0); setDone(null); setPending(null);
    if (!connected) return setMsg("Connect your devnet wallet first: you are the seller.");
    setBusy(true);
    try {
      const d = (await post("/api/sell/draft", {
        seller: connected.account.address, ...desc, tags: desc.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), ...(await source()),
      })) as unknown as Draft;
      setDraft(d);
      // Reveal the chain one step at a time.
      for (let i = 1; i <= (d.steps?.length ?? 0); i++) { setShown(i); await new Promise((r) => setTimeout(r, 400)); }
      if (d.ok) setPrice((Number(d.listing.price) / 1e6).toString());
      else setMsg(`Refused: ${d.reason} (${d.message})`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!draft?.ok || !connected) return;
    if (draft.needsConfirmation && !pii) return setMsg("Personal data was found: confirm you may sell it first.");
    const base = Math.round(Number(price) * 1e6);
    if (!Number.isFinite(base) || base <= 0) return setMsg("Enter a price in USDC.");
    setBusy(true); setMsg(null);
    try {
      // The price is yours to choose; the terms hash commits to the drafted price, so a new price is re-drafted.
      let d: Extract<Draft, { ok: true }> = draft;
      if (String(base) !== draft.listing.price) {
        const again = (await post("/api/sell/draft", { seller: connected.account.address, ...desc, tags: desc.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), price: String(base), ...(await source()) })) as unknown as Draft;
        if (!again.ok) throw new Error(`${again.reason}: ${again.message}`);
        d = again;
      }
      const listingId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
      const { listing, ixs } = await createListingIxs(createNoopSigner(connected.account.address as Address), PUBLIC_MINT as Address, listingId, d.listing);
      const sent = await sendWithWallet(connected.wallet, connected.account, PUBLIC_RPC, ixs);
      if (!sent.ok) throw new Error(sent.message);
      const p: Pending = { listing, signature: sent.signature, d, src: await source() };
      setPending(p);
      setMsg("Listing sent; waiting for the chain to confirm it…");
      if ((await confirmSignature(PUBLIC_RPC, sent.signature)) === "failed") {
        setPending(null);
        throw new Error("the listing transaction failed on chain; nothing was listed");
      }
      await finish(p);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Custody and assessment of a listing already on chain. Never signs or creates anything. */
  async function finish(p: Pending) {
    if (!connected) throw new Error("Connect your devnet wallet first: you are the seller.");
    setMsg(null);
    if (p.src.data) {
      const c = await post("/api/sell/custody", { listing: p.listing, seller: connected.account.address, data: p.src.data });
      if (!c.ok) throw new Error(`listed as ${p.listing}, but custody refused: ${c.reason} (${c.message})`);
    }
    const a = await post("/api/sell/assess", { listing: p.listing, contentHash: p.d.listing.contentHash, meta: p.d.meta, ...(p.src.service ? { service: p.src.service } : {}) });
    if (!a.ok) throw new Error(`listed as ${p.listing}, but the assessor refused: ${a.reason} (${a.message})`);
    setPending(null);
    setDone({ listing: p.listing, grade: String(a.grade) });
  }

  async function retry(p: Pending | null) {
    if (!p) return;
    setBusy(true);
    try {
      setPending(p);
      await finish(p);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!draft?.ok) return;
    const listing = resumeAt.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(listing)) return setMsg("Enter the listing address you already signed.");
    try {
      await retry({ listing, d: draft, src: await source() });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const steps = draft?.steps ?? [];
  const assess = steps.find((s) => s.step === "assess");
  const priced = steps.find((s) => s.step === "price");
  const drafted = steps.find((s) => s.step === "draft");
  // Where the seller is in the flow, for the progress track only.
  const at = done ? 4 : pending ? 3 : draft?.ok && shown >= steps.length ? 2 : busy || steps.length > 0 ? 1 : 0;
  const FLOW = ["Describe it", "Seller chain", "Review and price", "Sign in wallet", "Listed"];
  return (
    <section data-testid="sell-form" className="sell">
      <ol className="stage-track flow-track" aria-label="Progress">
        {FLOW.map((name, i) => (
          <li key={name} className={`stage is-${i < at || (i === 4 && done) ? "done" : i === at ? (draft && !draft.ok ? "declined" : busy ? "running" : "waiting") : "queued"}`} style={{ animationDelay: `${i * 0.08}s` }}>
            <span className="stage-node">{i < at || (i === 4 && done) ? "✓" : i + 1}</span>
            <span className="stage-name">{name}</span>
          </li>
        ))}
      </ol>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <div className="sheet-part">
          <span className="part-no">01</span>
          <fieldset className="choice-set">
            <legend>What you sell</legend>
            <label className="choice"><input type="radio" checked={mode === "data"} onChange={() => setMode("data")} /> <span><strong>Data</strong><small>a file, sold once per buyer, checked against its content hash</small></span></label>
            <label className="choice"><input type="radio" checked={mode === "service"} onChange={() => setMode("service")} /> <span><strong>A service</strong><small>an https endpoint, paid per call</small></span></label>
          </fieldset>
          {mode === "data" ? (
            <label className="dropzone">File (at most 10 MB) <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          ) : (
            <div className="field-grid">
              <label className="span-2">Endpoint <input value={service.endpoint} onChange={(e) => setService({ ...service, endpoint: e.target.value })} size={50} /></label>
              <label>Input schema (JSON) <input value={service.input} onChange={(e) => setService({ ...service, input: e.target.value })} size={50} /></label>
              <label>Output schema (JSON) <input value={service.output} onChange={(e) => setService({ ...service, output: e.target.value })} size={50} /></label>
              <label className="span-2">Example input (JSON) <input value={service.example} onChange={(e) => setService({ ...service, example: e.target.value })} size={50} /></label>
            </div>
          )}
        </div>
        <div className="sheet-part">
          <span className="part-no">02</span>
          <span className="eyebrow-mono">Describe it</span>
          <div className="field-grid">
            <label>Name <input required value={desc.name} onChange={(e) => setDesc({ ...desc, name: e.target.value })} /></label>
            <label>Category <input required value={desc.category} onChange={(e) => setDesc({ ...desc, category: e.target.value })} placeholder="energy" /></label>
            <label className="span-2">Description <input required value={desc.description} onChange={(e) => setDesc({ ...desc, description: e.target.value })} size={60} /></label>
            <label className="span-2">Tags (comma separated) <input value={desc.tags} onChange={(e) => setDesc({ ...desc, tags: e.target.value })} /></label>
          </div>
        </div>
        <div className="sheet-actions">
          <button type="submit" className="btn" data-magnet disabled={busy}>Run the seller chain</button>
          <span className="fine">Classify, assess, price and draft terms on the server. Nothing is signed yet.</span>
        </div>
      </form>
      {steps.length > 0 && (
        <div className="chain-log">
          <span className="eyebrow-mono">Seller chain{busy && shown < steps.length ? <span className="dots"><i /><i /><i /></span> : null}</span>
          <ol data-testid="sell-steps" className="feed">{steps.slice(0, shown).map((s, i) => (
            <li key={i} className={`tone-${s.step === "assess" && s.needsConfirmation ? "warn" : !draft?.ok && i === steps.length - 1 ? "crit" : "ok"}`}>
              <span className="feed-tag">{s.step}</span>
              <div>
                {describeStep(s)}
                {s.step === "assess" && (
                  <details data-testid="sell-report" open>
                    <summary>Assessment report{s.reportHash ? <> (hash <code>{String(s.reportHash).slice(0, 16)}…</code>)</> : null}</summary>
                    <ul>{reportLines(s.report as Parameters<typeof reportLines>[0]).map((l, j) => <li key={j}>{l}</li>)}</ul>
                  </details>
                )}
              </div>
            </li>
          ))}</ol>
        </div>
      )}
      {draft?.ok && shown >= steps.length && !done && (
        <div data-testid="sell-review" className="review-card">
          <div className="review-figures">
            {assess ? <div><span className="eyebrow-mono">Grade</span><strong className="figure">{String(assess.grade)}</strong></div> : null}
            {priced ? <div><span className="eyebrow-mono">Suggested range</span><strong className="figure-sm">{usdc(String(priced.low))} to {usdc(String(priced.high))}</strong></div> : null}
            {drafted ? <div><span className="eyebrow-mono">Terms hash</span><code>{String(drafted.termsHash).slice(0, 16)}…</code></div> : null}
          </div>
          <p>Reasons for the price: {(priced?.reasons as string[] | undefined)?.join("; ")}</p>
          <label className="price-field">Your price (USDC) <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} size={8} /></label>
          {draft.needsConfirmation && (
            <label className="confirm"><input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} /> The assessment found personal data. I confirm I may sell it.</label>
          )}
          {pending ? (
            <p data-testid="sell-pending" className="pending-note">
              Listing <code>{pending.listing}</code> is signed
              {pending.signature && <> (<a href={`https://explorer.solana.com/tx/${pending.signature}?cluster=devnet`} target="_blank" rel="noreferrer">transaction</a>)</>}.{" "}
              <button type="button" disabled={busy} onClick={() => void retry(pending)}>Retry custody and assessment (no new transaction)</button>
            </p>
          ) : (
            <>
              <button type="button" className="btn" data-magnet disabled={busy} onClick={() => void sign()}>Sign the listing (wallet)</button>
              <p className="resume">
                Already signed this listing? <input value={resumeAt} onChange={(e) => setResumeAt(e.target.value)} placeholder="listing address" size={44} aria-label="Listing address" />{" "}
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void resume()}>Finish custody and assessment</button>
              </p>
            </>
          )}
        </div>
      )}
      {done && (
        <div className="final-product">
          <span className="eyebrow-mono">Listed on chain</span>
          <p data-testid="sell-done">Listed: <a href={`/listing/${done.listing}`}><code>{done.listing}</code></a>, attested grade {done.grade} by the marketplace assessor.</p>
        </div>
      )}
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
