import type { ReactNode } from "react";
import Link from "next/link";
import { registryNote } from "../lib/site-registry";
import { NAV } from "./nav";
import { Motion } from "./motion";
import { WalletButton, WalletProvider } from "./wallet";
import "./globals.css";

export const metadata = { title: "Fiducia", description: "A marketplace for data, services and agent teams, settled on Solana" };

/** Long addresses and hashes wrap, and form fields never outgrow the screen (no sideways scroll at 390 px). */
const SHELL_CSS = "input, textarea, select { max-width: 100%; box-sizing: border-box; } p, li, dd, code, a { overflow-wrap: anywhere; }";
const FONTS = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap";
/** Before first paint: cover the page with the ink sheet once per session, so the intro never flashes content. */
const INTRO = "try{if(!sessionStorage.getItem('fiducia-intro')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.dataset.intro='1'}catch(e){}";
const TICKER = [
  "Grade attested on chain", "Escrow funded", "Sealed key delivered", "Stage approved by buyer",
  "Mandate cap enforced", "Released to seller", "Out-of-mandate spend refused", "Agent revoked in one click",
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
        <style>{SHELL_CSS}</style>
        <script dangerouslySetInnerHTML={{ __html: INTRO }} />
      </head>
      <body>
        <WalletProvider>
          <header className="site-header">
            <div className="site-header-row">
              <Link href="/" className="brand" aria-label="Fiducia home">
                <span className="sr-only"><strong>Fiducia</strong></span>
                <span className="brand-orbit" aria-hidden><span className="brand-dot" /><span className="brand-mark">f</span></span><span className="brand-word" aria-hidden>Fiduc<em>ia</em></span>
              </Link>
              <span className="header-spacer" />
              <span className="devnet-pill">Devnet</span>
              <span className="wallet-slot"><WalletButton /></span>
            </div>
            <nav aria-label="Main" className="main-nav">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}>{n.label}</Link>
              ))}
            </nav>
            <div className="ticker" aria-hidden>
              <div className="ticker-track">{[...TICKER, ...TICKER].map((t, i) => <span key={i}>{t}</span>)}</div>
            </div>
            <div className="scroll-progress" aria-hidden />
          </header>
          <div className="site-main">{children}</div>
          <footer className="site-footer">
            <div><span>Solana devnet only. Test tokens have no value. {registryNote()}</span><span>Fiducia · trust, enforced on Solana</span></div>
          </footer>
          <Motion />
        </WalletProvider>
      </body>
    </html>
  );
}
