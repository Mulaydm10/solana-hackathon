"use client";
// Load the connected wallet's own dashboard (#138): connecting with the header button fills in the seller.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../wallet";
import { connectedSellerHref } from "../../lib/dashboard";

export function ConnectedSeller({ shown }: { shown: string | null }) {
  const router = useRouter();
  const address = useWallet()?.account.address ?? null;
  useEffect(() => {
    const href = connectedSellerHref(shown, address);
    if (href) router.replace(href);
  }, [shown, address, router]);
  return null;
}
