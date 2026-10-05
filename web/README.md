# web — public marketplace site (Vercel)

Infrastructure only so far: a health route and a page proving `@deal/core` + `@deal/chain` run in the browser.
**Not deployed.**

## Rules this app follows
- Buyers sign with their own wallet; the site never holds buyer keys.
- Secrets (drafting key, verifier key) only in Vercel environment variables, read through `lib/env.ts`
  (schema-validated, fail closed, mainnet refused). Copy `.env.example` to `.env.local` for local dev.
- `lib/env.ts` is server-only. Never import it from a `"use client"` file.

## Add a feature
- **Server route:** `app/api/<name>/route.ts`. If it needs a secret, start with
  `const e = requireEnv(parseEnv(process.env), "verifier"); if (!e.ok) return Response.json(e.body, { status: e.status });`
- **Page/UI:** `app/<route>/page.tsx`; browser code imports `@deal/core` / `@deal/chain` (never `@deal/chain/node`).
- Add a test in `test/`; route handlers can be called directly (see `test/health.test.ts`).

## Test
`npm test` = typecheck → unit tests → `next build` (the build is what proves the shared lanes bundle for the browser).

## Demo mission for judges (#187)

Set `NEXT_PUBLIC_DEMO_MISSION` (and `NEXT_PUBLIC_DEMO_FEE_DEAL`) to a mission run by `npm run demo:mission --prefix agents`
(it prints both). /hire and the empty missions inbox then link to `/missions?m=<mission>&fee=<deal>`: the real mission,
read-only, no wallet needed. The mission service must run with the same `MISSION_STORE` as the demo run.
