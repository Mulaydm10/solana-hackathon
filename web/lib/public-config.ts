// Browser-visible configuration (no secrets): the cluster's RPC and the token the marketplace settles in.
export const PUBLIC_RPC = process.env.NEXT_PUBLIC_DEAL_RPC_URL ?? "https://api.devnet.solana.com";
/** Circle's devnet USDC: the same token for escrow deals and x402 calls (#88). */
export const PUBLIC_MINT = process.env.NEXT_PUBLIC_DEAL_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/**
 * The demo mission judges can watch without a wallet (#187): a real agent-team mission shown read-only on
 * /missions. Set NEXT_PUBLIC_DEMO_MISSION (and NEXT_PUBLIC_DEMO_FEE_DEAL for its fee deal) to show the link;
 * unset or malformed, there is no link. The literal process.env reads are what Next inlines for the browser.
 */
export function demoMissionLink(
  mission = process.env.NEXT_PUBLIC_DEMO_MISSION, feeDeal = process.env.NEXT_PUBLIC_DEMO_FEE_DEAL,
): string | null {
  const addr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!mission || !addr.test(mission)) return null;
  const q = new URLSearchParams({ m: mission });
  if (feeDeal && addr.test(feeDeal)) q.set("fee", feeDeal);
  return `/missions?${q.toString()}`;
}
