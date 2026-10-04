# web - contract

Public marketplace site, deployed on Vercel. Infrastructure only for now; features come in later issues.

- Buyers sign every buyer-side transaction with their own wallet (Wallet Standard, e.g. Phantom on devnet).
  The site never holds buyer keys.
- Server routes (Vercel functions) hold only what must be server-side: the drafting model key and the
  verifier key. Secrets come from Vercel environment variables, never from the repo.
- Uses `@deal/core` (terms) and `@deal/chain` (program client) through their browser-safe entry points.
- Verify: `npm test --prefix web` (unit tests + a production build).
