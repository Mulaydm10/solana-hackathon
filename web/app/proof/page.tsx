import { ChainCheck } from "../chain-check";

export default function Proof() {
  return (
    <main>
      <h1>Proof</h1>
      <p>Everything here is checked by the escrow program on Solana devnet, not by this site.</p>
      <ChainCheck />
    </main>
  );
}
