import { SellForm } from "./sell-form";

export default function Sell() {
  return (
    <main>
      <header className="page-head">
        <span className="eyebrow">Sell · seller chain · your wallet signs</span>
        <h1>Sell <em>data or a service</em></h1>
        <p>
          List data or a service. The seller chain classifies and assesses what you upload, suggests a price with its
          reasons and drafts the deal terms; you sign the listing with your own wallet. Data is kept encrypted by the
          marketplace custody, and buyers get the key only once their payment is in escrow.
        </p>
      </header>
      <SellForm />
    </main>
  );
}
