// Sell (#110, PLAN §8): upload data or register a service, watch the seller chain run step by step, review the
// draft price and terms, then sign create_listing in your own wallet. The marketplace's custody and assessor do
// the rest on the server; neither ever trusts a report or bytes it did not check itself.
import { SellForm } from "./sell-form";

export default function Sell() {
  return (
    <main>
      <h1>Sell</h1>
      <p>List data or a service. The seller chain classifies and assesses what you upload, suggests a price with its
        reasons and drafts the deal terms; you sign the listing with your own wallet. Data is kept encrypted by the
        marketplace custody, and buyers get the key only once their payment is in escrow.</p>
      <SellForm />
    </main>
  );
}
