import Link from "next/link";
import { usdc } from "../../lib/catalogue-json";
import { siteRegistry } from "../../lib/site-registry";
import { sellerView } from "../../lib/dashboard";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const view = typeof p.seller === "string" ? sellerView(await siteRegistry().list(), p.seller) : null;
  const seller = view?.seller ?? null;
  const mine = view?.listings ?? [];
  return (
    <main>
      <h1>Seller dashboard</h1>
      <form method="get"><input name="seller" placeholder="Seller wallet address" defaultValue={seller ?? ""} aria-label="Seller wallet" /> <button type="submit">Show</button></form>
      {!seller ? (
        <p data-testid="dashboard-empty">Enter a seller wallet (or connect yours) to see its listings and reputation.</p>
      ) : (
        <>
          <p data-testid="dashboard-rep">Reputation: {view?.summary}.</p>
          <ul data-testid="dashboard-listings">
            {mine.map((l) => (
              <li key={l.address}>
                <Link href={`/listing/${l.address}`}>{l.meta.name}</Link>: {usdc(l.price)}, {l.report ? `grade ${l.report.grade}` : "waiting for assessment"}, {l.sales} sales
              </li>
            ))}
          </ul>
          <p><em>Open deals and payouts appear here with the buy flow (#111).</em></p>
        </>
      )}
    </main>
  );
}
