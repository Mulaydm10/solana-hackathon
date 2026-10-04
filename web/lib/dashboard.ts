// Seller dashboard data (PLAN §4.3, read-only): one seller's active listings and its scored SellerRep. Grades
// and reputation come from the assessor and the chain; nothing the seller wrote decides them.
import { describeRep, repScore, type RepScore } from "@deal/core";
import type { RegistryListing } from "./registry";

export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SellerView = { seller: string; listings: RegistryListing[]; score: RepScore | null; summary: string };

export function sellerView(all: readonly RegistryListing[], seller: string): SellerView | null {
  if (!ADDRESS.test(seller)) return null;
  const listings = all.filter((l) => l.seller === seller);
  // SellerRep is per seller and mint; every listing of one seller in one mint carries the same counts.
  const score = listings[0] ? repScore(listings[0].rep) : null;
  return { seller, listings, score, summary: score ? describeRep(score) : "no listings yet" };
}
