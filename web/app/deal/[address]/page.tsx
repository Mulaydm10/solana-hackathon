// One escrow deal (#111): status from chain, and the next step for whoever is connected. Seller: accept, deliver.
// Buyer: get the data (key pickup), then release, or challenge. Every action is signed in the user's own wallet.
import { notFound } from "next/navigation";
import { DealView } from "./deal-view";

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function DealPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!ADDRESS.test(address)) notFound();
  return (
    <main>
      <p><a href="/">← Catalogue</a></p>
      <h1>Deal</h1>
      <p><code>{address}</code></p>
      <DealView deal={address} />
    </main>
  );
}
