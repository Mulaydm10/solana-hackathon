import Link from "next/link";
import { describeRep, formatAmount } from "@deal/core";
import { categories, parseQuery, search } from "../lib/catalogue";
import { demand } from "../lib/demand";
import { RegistryUnavailable, siteRegistry } from "../lib/site-registry";
import { usdc } from "./format";

export const dynamic = "force-dynamic";

const HERO_WORDS = "Buy data, services and whole AI agent teams; the chain enforces every rule".split(" ");
const KINDS = [
  { kind: "Data", href: "/?kind=Data#catalogue", copy: "The exact assessed bytes, checked against the content hash on chain.", settles: "escrow deal · sealed key", proof: "content hash" },
  { kind: "Service", href: "/?kind=Service#catalogue", copy: "Answers per call from an API whose method stays private.", settles: "x402 per call", proof: "no answer, no charge" },
  { kind: "Team", href: "/hire", copy: "A whole agent team with capped mandates and your approval at every stage.", settles: "mission budget", proof: "capped mandates" },
] as const;

/** The hero loupe's "on-chain view": the real content and report hashes behind the listings, repeated to fill. */
function hashWall(all: { address: string; contentHash: string; report?: { reportHash: string } | null }[]): string {
  const parts = all.flatMap((l) => [l.address, l.contentHash, l.report?.reportHash ?? ""]).filter(Boolean);
  if (parts.length === 0) return "";
  let out = "";
  for (let i = 0; out.length < 3200; i++) out += `${parts[i % parts.length]} `;
  return out;
}

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
      <section className="hero" data-loupe aria-labelledby="hero-h">
        <div className="hero-face">
          <span className="eyebrow">Agent marketplace · Solana devnet</span>
          <h1 id="hero-h" aria-label="Buy data, services and whole AI agent teams; the chain enforces every rule">
            {HERO_WORDS.map((w, i) => (
              <span key={i} className="word" aria-hidden><span style={{ animationDelay: `calc(${(0.08 * i).toFixed(2)}s + var(--intro, 0s))` }}>{i >= 8 ? <em>{w}</em> : w}</span></span>
            ))}
          </h1>
          <p>Grades are attested, money waits in escrow, and agents can&apos;t spend a cent without your approval.</p>
          <div className="hero-actions">
            <a className="btn" data-magnet href="#catalogue">Browse catalogue ↓</a>
            <Link className="btn btn-ghost" data-magnet href="/sell">Sell something</Link>
          </div>
          <span className="coords">A–H · 1–4 · the chain is underneath</span>
        </div>
        <div className="hero-ink" aria-hidden>
          <div className="hash-wall">{hashWall(all)}</div>
          <div className="hero-face">
            <span className="eyebrow">On-chain view · verified</span>
            <div className="hero-title">{HERO_WORDS.map((w, i) => <span key={i} className="word"><span>{i >= 8 ? <em>{w}</em> : w}</span></span>)}</div>
            <p>Grades are attested, money waits in escrow, and agents can&apos;t spend a cent without your approval.</p>
            <div className="hero-actions"><span className="pill-fn">create_deal()</span><span className="pill-fn">create_listing()</span></div>
            <span className="coords">Every claim above resolves to an account on Solana</span>
          </div>
        </div>
        <div className="loupe-ring" aria-hidden><i /><i /><i /><i /><span>On-chain view</span></div>
      </section>

      <div className="tiles-head">
        <span className="eyebrow-mono">Three ways to trade · hover to flip</span>
        <h2>Data, services, whole teams.</h2>
      </div>
      <div className="kind-tiles" aria-label="What you can buy">
        {KINDS.map((k, i) => (
          <Link key={k.kind} className="flip" data-kind={k.kind} href={k.href}>
            <span className="flip-inner">
              <span className="flip-face flip-front">
                <span className="fig">Specimen {String(i + 1).padStart(2, "0")} · {all.filter((l) => l.kind === k.kind).length} listed</span>
                <span className={`flip-shape shape-${k.kind}`} aria-hidden />
                <h3>{k.kind}</h3>
                <span className="flip-copy">{k.copy}</span>
              </span>
              <span className="flip-face flip-back">
                <span className="fig">On-chain view</span>
                <span className="flip-rows">
                  <span><span>kind</span><span>{k.kind}</span></span>
                  <span><span>settles</span><span>{k.settles}</span></span>
                  <span><span>proof</span><span>{k.proof}</span></span>
                  <span><span>listed</span><span>{all.filter((l) => l.kind === k.kind).length}</span></span>
                </span>
                <span className="flip-cta">{k.kind === "Team" ? "Hire a team →" : "Open catalogue →"}</span>
              </span>
            </span>
          </Link>
        ))}
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
          <li key={l.address} data-testid="listing" style={{ animationDelay: `${Math.min(i, 8) * 0.06}s` }}><div className="listing-card" data-tilt>
            <div className="listing-meta">
              <span className={`chip chip-${l.kind}`}>{l.kind}</span>
              <span className="chip">{l.meta.category}</span>
              <span className="header-spacer" />
              {l.report ? <span className="grade" title="Grade attested on chain">grade <strong data-testid="grade">{l.report.grade}</strong></span> : <em className="grade-none">not assessed yet</em>}
            </div>
            <Link className="name" href={`/listing/${l.address}`}><strong>{l.meta.name}</strong></Link>
            <span className="rep">seller {describeRep(l.score)}</span>
            <div className="listing-price"><span>{usdc(l.price)}{l.kind === "Service" ? " per call" : ""}</span><span>devnet</span></div>
          </div></li>
        ))}
      </ul>
    </main>
  );
}
