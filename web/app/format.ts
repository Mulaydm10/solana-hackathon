// Shared display helpers (server and client safe).
import { formatAmount } from "@deal/core";

export const usdc = (base: bigint) => `${formatAmount(base, 6)} USDC`;
export const explorer = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;
