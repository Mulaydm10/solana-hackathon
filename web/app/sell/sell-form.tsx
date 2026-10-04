"use client";
// The sell flow in the browser (#110): upload or describe, watch the seller chain run on the server step by step,
// review grade, price and terms, then sign create_listing in your own wallet. After that the marketplace custody
// takes the data (checked against the on-chain content hash) and the marketplace assessor attests its own report.
import { useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import { useWallet } from "../wallet";
import { sendWithWallet } from "../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../lib/public-config";
import { createListingIxs, MAX_UPLOAD_BYTES, readReply, reportLines, toBase64, tooLarge, type DraftedListing } from "../../lib/sell-tx";

type Step = { step: string; [k: string]: unknown };
type Draft = { ok: true; steps: Step[]; meta: Record<string, unknown>; needsConfirmation: boolean; listing: DraftedListing } | { ok: false; reason: string; message: string; steps?: Step[] };

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

  async function source(): Promise<{ data?: string; service?: Record<string, unknown> }> {
    if (mode === "data") {
      if (!file) throw new Error("choose a file");
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(tooLarge(file.size));
      return { data: toBase64(new Uint8Array(await file.arrayBuffer())) };
    }
    return { service: { endpoint: service.endpoint, input_schema: JSON.parse(service.input), output_schema: JSON.parse(service.output), example_input: JSON.parse(service.example) } };
  }

  async function run() {
    setMsg(null); setDraft(null); setShown(0); setDone(null);
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
      const src = await source();
      if (src.data) {
        const c = await post("/api/sell/custody", { listing, seller: connected.account.address, data: src.data });
        if (!c.ok) throw new Error(`custody: ${c.reason} (${c.message})`);
      }
      const a = await post("/api/sell/assess", { listing, contentHash: d.listing.contentHash, meta: d.meta, ...(src.service ? { service: src.service } : {}) });
      if (!a.ok) throw new Error(`listed as ${listing}, but the assessor refused: ${a.reason} (${a.message})`);
      setDone({ listing, grade: String(a.grade) });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const steps = draft?.steps ?? [];
  return (
    <section data-testid="sell-form">
      <form onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <fieldset>
          <legend>What you sell</legend>
          <label><input type="radio" checked={mode === "data"} onChange={() => setMode("data")} /> Data (a file)</label>{" "}
          <label><input type="radio" checked={mode === "service"} onChange={() => setMode("service")} /> A service (an https endpoint)</label>
          {mode === "data" ? (
            <label style={{ display: "block" }}>File (at most 10 MB) <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          ) : (
            <>
              <label style={{ display: "block" }}>Endpoint <input value={service.endpoint} onChange={(e) => setService({ ...service, endpoint: e.target.value })} size={50} /></label>
              <label style={{ display: "block" }}>Input schema (JSON) <input value={service.input} onChange={(e) => setService({ ...service, input: e.target.value })} size={50} /></label>
              <label style={{ display: "block" }}>Output schema (JSON) <input value={service.output} onChange={(e) => setService({ ...service, output: e.target.value })} size={50} /></label>
              <label style={{ display: "block" }}>Example input (JSON) <input value={service.example} onChange={(e) => setService({ ...service, example: e.target.value })} size={50} /></label>
            </>
          )}
        </fieldset>
        <label style={{ display: "block" }}>Name <input required value={desc.name} onChange={(e) => setDesc({ ...desc, name: e.target.value })} /></label>
        <label style={{ display: "block" }}>Description <input required value={desc.description} onChange={(e) => setDesc({ ...desc, description: e.target.value })} size={60} /></label>
        <label style={{ display: "block" }}>Category <input required value={desc.category} onChange={(e) => setDesc({ ...desc, category: e.target.value })} placeholder="energy" /></label>
        <label style={{ display: "block" }}>Tags (comma separated) <input value={desc.tags} onChange={(e) => setDesc({ ...desc, tags: e.target.value })} /></label>
        <button type="submit" disabled={busy}>Run the seller chain</button>
      </form>
      {steps.length > 0 && <ol data-testid="sell-steps">{steps.slice(0, shown).map((s, i) => (
        <li key={i}>
          {describeStep(s)}
          {s.step === "assess" && (
            <details data-testid="sell-report" open>
              <summary>Assessment report{s.reportHash ? <> (hash <code>{String(s.reportHash).slice(0, 16)}…</code>)</> : null}</summary>
              <ul>{reportLines(s.report as Parameters<typeof reportLines>[0]).map((l, j) => <li key={j}>{l}</li>)}</ul>
            </details>
          )}
        </li>
      ))}</ol>}
      {draft?.ok && shown >= steps.length && !done && (
        <div data-testid="sell-review">
          <p>Reasons for the price: {(steps.find((s) => s.step === "price")?.reasons as string[] | undefined)?.join("; ")}</p>
          <label>Your price (USDC) <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} size={8} /></label>
          {draft.needsConfirmation && (
            <label style={{ display: "block" }}><input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} /> The assessment found personal data. I confirm I may sell it.</label>
          )}
          <button type="button" disabled={busy} onClick={() => void sign()}>Sign the listing (wallet)</button>
        </div>
      )}
      {done && <p data-testid="sell-done">Listed: <a href={`/listing/${done.listing}`}><code>{done.listing}</code></a>, attested grade {done.grade} by the marketplace assessor.</p>}
      {msg && <p role="alert">{msg}</p>}
    </section>
  );
}
