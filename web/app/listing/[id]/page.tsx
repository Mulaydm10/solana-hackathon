import { notFound } from "next/navigation";
import { base58Encode, describeListing, describeRep, repScore, suggestPrice } from "@deal/core";
import { parseEnv } from "../../../lib/env";
import { siteRegistry } from "../../../lib/site-registry";
import { explorer, usdc } from "../../format";
import { BuyPanel } from "./buy-panel";

/** The verifier's public address (never the key): the last 32 bytes of DEAL_VERIFIER_KEY. Default key = no verifier. */
function verifierAddress(): string {
  const e = parseEnv(process.env);
  if (!e.ok || !e.env.DEAL_VERIFIER_KEY) return "11111111111111111111111111111111";
  return base58Encode(Uint8Array.from((JSON.parse(e.env.DEAL_VERIFIER_KEY) as number[]).slice(32)));
}

export const dynamic = "force-dynamic";

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reg = siteRegistry();
  const l = await reg.get(id);
  if (!l) notFound();
  const rep = repScore(l.rep);
  // Grade from the assessor's report only; the seller's own text is quoted, never trusted.
  const summary = describeListing({ meta: l.meta, price: l.price, seller: l.seller, grade: l.report?.grade, rep }, { decimals: 6, symbol: "USDC" });
  // Price reasons, recomputed in code from other sellers' listings in the same category and kind.
  const comparables = (await reg.list())
    .filter((c) => c.address !== l.address && c.kind === l.kind && c.meta.category === l.meta.category)
    .map((c) => ({ kind: c.kind, price: c.price, sold: c.sales > 0, seller: c.seller }));
  const suggestion = suggestPrice({
    kind: l.kind, seller: l.seller, comparables, rep,
    ...(l.report ? { assessment: { grade: l.report.grade, sizeBytes: l.meta.kind === "Data" ? l.meta.sizeBytes : undefined } } : {}),
    ...(l.report?.ageDays !== undefined ? { ageDays: l.report.ageDays } : {}),
  });

  return (
    <main>
      <p><a href="/">← Catalogue</a></p>
      <h1>{l.meta.name}</h1>
      <p data-testid="summary">{summary}</p>

      <h2>Quality</h2>
      {l.report ? (
        <ul>
          <li>Grade <strong data-testid="grade">{l.report.grade}</strong>, from the assessor's report (not from the seller's description).</li>
          {l.report.ageDays !== undefined ? <li>Newest data: {l.report.ageDays} days old.</li> : null}
          {l.report.containsPersonalData ? <li data-testid="pii">Contains personal data. The seller confirmed listing it.</li> : null}
          <li>Report hash <code>{l.report.reportHash.slice(0, 16)}…</code>, attested by assessor <code>{l.report.assessor.slice(0, 8)}…</code></li>
        </ul>
      ) : (
        <p data-testid="unattested">Not assessed yet. It can't be bought until a registered assessor attests it.</p>
      )}

      <h2>Seller</h2>
      <p data-testid="rep">{describeRep(rep)}. {l.rep.completed.toString()} completed deals with {l.rep.distinctBuyers.toString()} different buyers.</p>

      <h2>Price</h2>
      <p>Listed at <strong>{usdc(l.price)}</strong>{l.kind === "Service" ? " per call" : ""}. Suggested range {usdc(suggestion.low)} to {usdc(suggestion.high)}:</p>
      <ul data-testid="price-reasons">{suggestion.reasons.map((r) => <li key={r}>{r}</li>)}</ul>

      <h2>On chain</h2>
      <ul>
        <li><a href={explorer(l.address)}>Listing account</a> (demo data: these links work once the registry is on chain)</li>
        <li><a href={explorer(l.seller)}>Seller</a></li>
        <li>Content hash <code>{l.contentHash.slice(0, 16)}…</code>{l.kind === "Data" ? " (a delivery must match it exactly)" : ""}</li>
        <li>{l.sales} completed sales</li>
      </ul>
      {l.kind === "Team" ? (
        <p><a href="/hire">Hire this team</a>: a team is hired with a mission, not bought.</p>
      ) : (
        <BuyPanel
          listing={{ address: l.address, seller: l.seller, kind: l.kind, mint: l.mint, price: l.price.toString(), contentHash: l.contentHash, name: l.meta.name }}
          verifier={verifierAddress()}
          attested={l.report !== null}
        />
      )}
    </main>
  );
}
