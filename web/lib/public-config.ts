// Browser-visible configuration (no secrets): the cluster's RPC and the token the marketplace settles in.
export const PUBLIC_RPC = process.env.NEXT_PUBLIC_DEAL_RPC_URL ?? "https://api.devnet.solana.com";
/** Circle's devnet USDC: the same token for escrow deals and x402 calls (#88). */
export const PUBLIC_MINT = process.env.NEXT_PUBLIC_DEAL_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
