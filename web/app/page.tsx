import Link from "next/link";
import { describeRep, formatAmount } from "@deal/core";
import { categories, parseQuery, search } from "../lib/catalogue";
import { demand } from "../lib/demand";
import { RegistryUnavailable, siteRegistry } from "../lib/site-registry";
import { usdc } from "./format";

export const dynamic = "force-dynamic";

const HERO_WORDS = "Buy data, services and whole AI agent teams; the chain enforces every rule".split(" ");

export default async function Catalogue({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = parseQuery(params);
  let all;
  try {
    all = await siteRegistry().list();
  } catch (e) {
    if (!(e instanceof RegistryUnavailable)) throw e;
    return (
      <main>
        <h1>Catalogue</h1>
        <p role="alert" data-testid="registry-unavailable">
          The listing registry is temporarily unavailable (the devnet RPC did not answer). <a href={`/?${new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])))}`}>Try again</a> in a few seconds.
        </p>
      </main>
    );
  }
  const results = search(all, query);
  if (results.length === 0) demand.record({ q: query.q, category: query.category, kind: query.kind, budget: query.maxPrice });
  return (
    <main>
      <section className="hero" aria-labelledby="hero-h">
        <span className="eyebrow">Agent marketplace · Solana devnet</span>
        <h1 id="hero-h" aria-label="Buy data, services and whole AI agent teams; the chain enforces every rule">
          {HERO_WORDS.map((w, i) => (
            <span key={i} className="word" aria-hidden><span style={{ animationDelay: `${0.08 * i}s` }}>{i >= 8 ? <em>{w}</em> : w}</span></span>
          ))}
        </h1>
        <p>Grades are attested, money waits in escrow, and agents can&apos;t spend a cent without your approval.</p>
        <div className="hero-actions">
          <a className="btn" href="#catalogue">Browse catalogue ↓</a>
          <Link className="btn btn-ghost" href="/sell">Sell something</Link>
        </div>
        <span className="coords">A–H · 1–4 · the chain is underneath</span>
      </section>

      <div className="kind-tiles" aria-label="What you can buy">
        <Link className="tile" data-kind="Data" href="/?kind=Data#catalogue"><span className="fig">Kind 01</span><h3>Data</h3><p>The exact assessed bytes, checked against the content hash on chain.</p><span className="foot">Escrow deal · sealed key</span></Link>
        <Link className="tile" data-kind="Service" href="/?kind=Service#catalogue"><span className="fig">Kind 02</span><h3>Service</h3><p>Answers per call from an API whose method stays private.</p><span className="foot">x402 per call · no answer, no charge</span></Link>
        <Link className="tile" data-kind="Team" href="/hire"><span className="fig">Kind 03</span><h3>Team</h3><p>A whole agent team with capped mandates and your approval at every stage.</p><span className="foot">Mission budget · revoke in one click</span></Link>
      </div>

      <div className="trust-strip" aria-label="How trust works">
        <div className="tile"><span className="num" aria-hidden>01</span><span className="fig">Fig. 01 · Attestation</span><h3>Every grade is <em>attested</em>.</h3><p>A registered assessor posts the grade on chain; we show it only if the report hashes to that on-chain hash.</p></div>
        <div className="tile"><span className="num" aria-hidden>02</span><span className="fig">Fig. 02 · Escrow</span><h3>Your money waits in <em>escrow</em>.</h3><p>Release when you are happy, or challenge and an independent verifier rules.</p></div>
        <div className="tile"><span className="num" aria-hidden>03</span><span className="fig">Fig. 03 · Mandate</span><h3>Agents stay <em>inside their mandate</em>.</h3><p>Per-agent caps, stage gates you sign, and one-click revoke.</p></div>
      </div>

      <div className="section-head" id="catalogue">
        <h2>Catalogue</h2>
        <p data-testid="result-count">{results.length} of {all.length} listings</p>
      </div>
      <p>Data, services and agent teams. Free to browse; buying needs a devnet wallet.</p>
      <form method="get" action="/#catalogue" aria-label="Search">
        <input name="q" placeholder="Search" defaultValue={query.q ?? ""} aria-label="Search words" />
        <select name="kind" defaultValue={query.kind ?? ""} aria-label="Kind">
          <option value="">Any kind</option>
          <option>Data</option>
          <option>Service</option>
          <option>Team</option>
        </select>
        <select name="category" defaultValue={query.category ?? ""} aria-label="Category">
          <option value="">Any category</option>
          {categories(all).map((c) => <option key={c}>{c}</option>)}
        </select>
        <select name="minGrade" defaultValue={query.minGrade ?? ""} aria-label="Minimum grade">
          <option value="">Any grade</option>
          {["A", "B", "C", "D"].map((g) => <option key={g} value={g}>Grade {g} or better</option>)}
        </select>
        <input name="maxUsdc" inputMode="decimal" placeholder="Max price (USDC)" defaultValue={query.maxPrice === undefined ? "" : formatAmount(query.maxPrice, 6)} aria-label="Maximum price in USDC" />
        <label><input type="checkbox" name="hideFlagged" value="1" defaultChecked={query.hideFlagged} /> Hide flagged sellers</label>
        <label><input type="checkbox" name="attestedOnly" value="1" defaultChecked={query.attestedOnly} /> Assessed only</label>
        <button type="submit">Search</button>
      </form>
      <ul className="listing-grid">
        {results.map((l, i) => (
          <li key={l.address} data-testid="listing" style={{ animationDelay: `${Math.min(i, 8) * 0.06}s` }}>
            <div className="listing-meta">
              <span className={`chip chip-${l.kind}`}>{l.kind}</span>
              <span className="chip">{l.meta.category}</span>
              <span className="header-spacer" />
              {l.report ? <span className="grade" title="Grade attested on chain">grade <strong data-testid="grade">{l.report.grade}</strong></span> : <em className="grade-none">not assessed yet</em>}
            </div>
            <Link className="name" href={`/listing/${l.address}`}><strong>{l.meta.name}</strong></Link>
            <span className="rep">seller {describeRep(l.score)}</span>
            <div className="listing-price"><span>{usdc(l.price)}{l.kind === "Service" ? " per call" : ""}</span><span>devnet</span></div>
          </li>
        ))}
      </ul>
    </main>
  );
}
