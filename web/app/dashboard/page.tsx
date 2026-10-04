import Link from "next/link";
import { describeRep, repScore } from "@deal/core";
import { usdc } from "../../lib/catalogue-json";
import { siteRegistry } from "../../lib/site-registry";

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const seller = typeof p.seller === "string" && ADDRESS.test(p.seller) ? p.seller : null;
  const mine = seller ? (await siteRegistry().list()).filter((l) => l.seller === seller) : [];
  return (
    <main>
      <h1>Seller dashboard</h1>
      <form method="get"><input name="seller" placeholder="Seller wallet address" defaultValue={seller ?? ""} aria-label="Seller wallet" /> <button type="submit">Show</button></form>
      {!seller ? (
        <p data-testid="dashboard-empty">Enter a seller wallet (or connect yours) to see its listings and reputation.</p>
      ) : (
        <>
          <p data-testid="dashboard-rep">Reputation: {mine[0] ? describeRep(repScore(mine[0].rep)) : "no listings yet"}.</p>
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
