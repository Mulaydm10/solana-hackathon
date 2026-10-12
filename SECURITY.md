# Security policy

Fiducia runs on **Solana devnet with test USDC** and has **not been externally audited**. Don't use it with real funds.

## Report a vulnerability

Please report privately through GitHub: **Security** tab → **Report a vulnerability**
(<https://github.com/Mulaydm10/solana-hackathon/security/advisories/new>).
Please don't open a public issue for a vulnerability.

Include what you found, the instruction or file, steps or a test that reproduces it, and the impact you expect.
We aim to reply within 3 days.

## Scope

- The Solana program `deal_escrow` ([`chain/anchor/programs/deal_escrow`](chain/anchor/programs/deal_escrow)), devnet `CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV`
- Signing and sending code: [`chain/src`](chain/src) (`safeSend`, `exactlyOnce`) and [`agents/`](agents)
- The web app and its API routes ([`web/`](web)) and the MCP server ([`mcp/`](mcp))

Out of scope: third-party services (RPC providers, Vercel, peaq), devnet faucets, and attacks that need a user's own wallet key.

## For auditors

[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) covers the scope, accounts, roles, invariants, evidence and known open items.
