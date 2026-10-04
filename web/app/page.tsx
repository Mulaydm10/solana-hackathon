import Link from "next/link";
import { describeRep } from "@deal/core";
import { categories, parseQuery, search } from "../lib/catalogue";
import { demand } from "../lib/demand";
import { siteRegistry } from "../lib/site-registry";
import { usdc } from "./format";

export const dynamic = "force-dynamic";

export default async function Catalogue({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseQuery(await searchParams);
  const all = await siteRegistry().list();
  const results = search(all, query);
  if (results.length === 0) demand.record({ q: query.q, category: query.category, kind: query.kind, budget: query.maxPrice });
  return (
    <main>
      <h1>Catalogue</h1>
      <p>Data, services and agent teams. Free to browse; buying needs a devnet wallet.</p>
      <form method="get" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }} aria-label="Search">
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
        <input name="maxPrice" placeholder="Max price (base units)" defaultValue={query.maxPrice?.toString() ?? ""} aria-label="Maximum price in base units" />
        <label><input type="checkbox" name="hideFlagged" value="1" defaultChecked={query.hideFlagged} /> Hide flagged sellers</label>
        <label><input type="checkbox" name="attestedOnly" value="1" defaultChecked={query.attestedOnly} /> Assessed only</label>
        <button type="submit">Search</button>
      </form>
      <p data-testid="result-count">{results.length} of {all.length} listings</p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {results.map((l) => (
          <li key={l.address} data-testid="listing" style={{ borderTop: "1px solid #eee", padding: "12px 0" }}>
            <Link href={`/listing/${l.address}`}><strong>{l.meta.name}</strong></Link>{" "}
            <small>{l.kind} · {l.meta.category}</small>
            <div>
              {usdc(l.price)}{l.kind === "Service" ? " per call" : ""} ·{" "}
              {l.report ? <>grade <strong data-testid="grade">{l.report.grade}</strong></> : <em>not assessed yet</em>} ·{" "}
              seller {describeRep(l.score)}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
