"use client";
// Proves the shared lanes bundle for the browser: the program id comes from @deal/chain and the
// terms hash is computed client-side by @deal/core. Replaced by the marketplace UI later.
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { termsHash } from "@deal/core";

const SAMPLE = {
  template: "pay_on_delivery" as const, buyer: "Buyer", seller: "Seller", serviceId: "translate",
  task: "sample", price: 1n, deadline: 1_800_000_000, reviewSecs: 600,
};

export function ChainCheck() {
  const hex = Array.from(termsHash(SAMPLE), (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    <dl>
      <dt>Escrow program</dt>
      <dd><code>{DEAL_ESCROW_PROGRAM_ADDRESS}</code></dd>
      <dt>Terms hash computed in this browser</dt>
      <dd><code data-testid="terms-hash">{hex}</code></dd>
    </dl>
  );
}
