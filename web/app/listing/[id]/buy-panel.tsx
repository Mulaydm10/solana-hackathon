"use client";
// Buy from a listing (#111): set up a budget once if this wallet has none, then open the escrow deal in the wallet.
// Everything signed is built here from the program's builders; the site never holds a key.
import { useEffect, useState } from "react";
import { createNoopSigner, createSolanaRpc, type Address } from "@solana/kit";
import { fetchMaybeBuyerPolicy, policyAddress } from "@deal/chain";
import { useWallet } from "../../wallet";
import { sendWithWallet } from "../../../lib/wallet-tx";
import { PUBLIC_MINT, PUBLIC_RPC } from "../../../lib/public-config";
import { buyIx, policyIx, type ListingForSale } from "../../../lib/buy-flow";

export type BuyPanelProps = { listing: Omit<ListingForSale, "price"> & { price: string }; verifier: string; attested: boolean };

const toBase = (usdc: string) => (/^\d{1,9}(\.\d{1,6})?$/.test(usdc) ? BigInt(Math.round(Number(usdc) * 1e6)) : null);

export function BuyPanel({ listing, verifier, attested }: BuyPanelProps) {
  const connected = useWallet();
  const [hasPolicy, setHasPolicy] = useState<boolean | null>(null);
  const [budget, setBudget] = useState("50");
  const [maxPrice, setMaxPrice] = useState(String(Math.max(1, Math.ceil(Number(listing.price) / 1e6))));
  const [onlyThisSeller, setOnlyThisSeller] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const l: ListingForSale = { ...listing, price: BigInt(listing.price) };

  useEffect(() => {
    if (!connected) return;
    (async () => {
      const p = await fetchMaybeBuyerPolicy(createSolanaRpc(PUBLIC_RPC), await policyAddress(connected.account.address as Address)).catch(() => null);
      setHasPolicy(p ? p.exists : null);
    })();
  }, [connected]);

  if (!attested) return <p data-testid="buy-unavailable">This listing can be bought once a registered assessor attests it.</p>;
  if (listing.mint !== PUBLIC_MINT) return <p data-testid="buy-unavailable">This listing is priced in another token than this site settles in.</p>;
  if (!connected) return <p data-testid="buy-connect">Connect a devnet wallet to buy. Your wallet signs the escrow deal; the site never holds your key.</p>;

  const buyer = createNoopSigner(connected.account.address as Address);

  async function setUpBudget() {
    setMsg(null);
    const b = toBase(budget);
    const m = toBase(maxPrice);
    if (b === null || m === null) return setMsg("Enter amounts in USDC.");
    const r = await policyIx(buyer, PUBLIC_MINT as Address, { periodBudget: b, maxPrice: m, allowedSellers: onlyThisSeller ? [listing.seller] : null });
    if (!r.ok) return setMsg(r.message);
    setBusy(true);
    const s = await sendWithWallet(connected!.wallet, connected!.account, PUBLIC_RPC, [r.ix]);
    setBusy(false);
    if (!s.ok) return setMsg(`Not set up: ${s.message}`);
    setHasPolicy(true);
    setMsg("Budget set up on chain. Every purchase is checked against it by the program.");
  }

  async function buy() {
    setMsg(null);
    const r = await buyIx(buyer, l, { mint: PUBLIC_MINT, verifier, now: Math.floor(Date.now() / 1000) });
    if (!r.ok) return setMsg(r.message);
    setBusy(true);
    const s = await sendWithWallet(connected!.wallet, connected!.account, PUBLIC_RPC, [r.ix]);
    if (!s.ok) {
      setBusy(false);
      return setMsg(`Not bought: ${s.message}`);
    }
    // Keep the terms the deal committed to, for the verifier (stored only if they hash to the on-chain terms hash).
    await fetch(`/api/deals/${r.deal}/terms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ terms: r.terms }) }).catch(() => {});
    window.location.href = `/deal/${r.deal}`;
  }

  return (
    <section data-testid="buy-panel">
      <h2>Buy</h2>
      {hasPolicy === false ? (
        <div data-testid="budget-setup">
          <p><strong>Set up your budget first.</strong> The escrow program checks every purchase against your own on-chain spending policy.</p>
          <label>Budget per day (USDC) <input value={budget} onChange={(e) => setBudget(e.target.value)} /></label>{" "}
          <label>Max price per purchase (USDC) <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} /></label>{" "}
          <label><input type="checkbox" checked={onlyThisSeller} onChange={(e) => setOnlyThisSeller(e.target.checked)} /> Only allow this seller</label>{" "}
          <button type="button" disabled={busy} onClick={setUpBudget}>Sign budget in wallet</button>
        </div>
      ) : (
        <p>
          The price goes into escrow. The seller is paid only after delivering{listing.kind === "Data" ? " exactly the assessed file" : ""}; you can release, or challenge before the review window ends.{" "}
          <button type="button" data-testid="buy-button" disabled={busy || hasPolicy === null} onClick={buy}>Buy in wallet</button>
        </p>
      )}
      {msg ? <p role="status">{msg}</p> : null}
    </section>
  );
}
