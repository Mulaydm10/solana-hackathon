import Link from "next/link";
import { usdc } from "../../lib/catalogue-json";
import { siteRegistry } from "../../lib/site-registry";
import { sellerView } from "../../lib/dashboard";
import { ConnectedSeller } from "./connected-seller";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const view = typeof p.seller === "string" ? sellerView(await siteRegistry().list(), p.seller) : null;
  const seller = view?.seller ?? null;
  const mine = view?.listings ?? [];
  const sales = mine.reduce((n, l) => n + l.sales, 0);
  const attested = mine.filter((l) => l.report).length;
  return (
    <main>
      <header className="page-head">
        <span className="eyebrow">Seller · listings and reputation from chain</span>
        <h1>Seller <em>dashboard</em></h1>
      </header>
      <ConnectedSeller shown={seller} />
      <form method="get" className="lookup"><input name="seller" placeholder="Seller wallet address" defaultValue={seller ?? ""} aria-label="Seller wallet" /> <button type="submit">Show</button></form>
      {!seller ? (
        <p data-testid="dashboard-empty" className="empty-note">Enter a seller wallet (or connect yours) to see its listings and reputation.</p>
      ) : (
        <>
          <div className="seller-sheet">
            <div className="seller-id">
              <span className="agent-avatar" aria-hidden>S</span>
              <div>
                <span className="eyebrow-mono">Seller wallet</span>
                <code>{seller}</code>
              </div>
            </div>
            <div className="seller-stats">
              <div><span className="eyebrow-mono">Listings</span><strong className="figure-sm">{mine.length}</strong></div>
              <div><span className="eyebrow-mono">Attested</span><strong className="figure-sm">{attested}</strong></div>
              <div><span className="eyebrow-mono">Sales</span><strong className="figure-sm">{sales}</strong></div>
            </div>
            <p data-testid="dashboard-rep" className="rep-line">Reputation: {view?.summary}.</p>
          </div>
          {mine.length === 0 ? <p className="empty-note">This wallet has no listings yet. <Link href="/sell">Sell something</Link>.</p> : null}
          <ul data-testid="dashboard-listings" className="listing-grid">
            {mine.map((l) => (
              <li key={l.address}>
                <article className="listing-card" data-tilt>
                  <div className="listing-meta">
                    <span className={`chip chip-${l.kind}`}>{l.kind}</span>
                    {l.report ? <span className="grade">grade <strong>{l.report.grade}</strong></span> : <span className="grade-none">waiting for assessment</span>}
                  </div>
                  <Link className="name" href={`/listing/${l.address}`}>{l.meta.name}</Link>
                  <div className="listing-price"><span>{usdc(l.price)}</span><span>{l.sales} sales</span></div>
                </article>
              </li>
            ))}
          </ul>
          <p><em>Open deals and payouts appear here with the buy flow (#111).</em></p>
        </>
      )}
    </main>
  );
}
