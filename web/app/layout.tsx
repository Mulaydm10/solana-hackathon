import type { ReactNode } from "react";
import Link from "next/link";
import { registryNote } from "../lib/site-registry";
import { NAV } from "./nav";
import { WalletButton, WalletProvider } from "./wallet";

export const metadata = { title: "Deal Desk", description: "A marketplace for data, services and agent teams, settled on Solana" };

/** Long addresses and hashes wrap, and form fields never outgrow the screen (no sideways scroll at 390 px). */
const SHELL_CSS = "input, textarea, select { max-width: 100%; box-sizing: border-box; } p, li, dd, code, a { overflow-wrap: anywhere; }";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><style>{SHELL_CSS}</style></head>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, color: "#1a1a1a" }}>
        <WalletProvider>
        <header style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid #ddd" }}>
          <nav aria-label="Main" style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <strong>Deal Desk</strong>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
          </nav>
          <WalletButton />
        </header>
        <div style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>{children}</div>
        <footer style={{ padding: "12px 24px", fontSize: 12, color: "#666" }}>Solana devnet only. Test tokens have no value. {registryNote()}</footer>
        </WalletProvider>
      </body>
    </html>
  );
}
