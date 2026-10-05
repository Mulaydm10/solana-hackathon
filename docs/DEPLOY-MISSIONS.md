# DEPLOY-MISSIONS.md: hosting the mission service, and every variable it and Vercel need

The hire flow, the missions page and "Try the demo" all talk to one long-running process: the **mission service**
(`agents/scripts/serve-missions.ts`). Vercel functions cannot run it: it holds each mission's agent keys in memory,
runs every agent in its own isolated worker process, and waits on the chain for the buyer's stage approvals for as long
as a mission lasts. Run it on a machine that stays up (a small VPS, the Omen, or the Mac), and let the site reach it
over HTTPS.

Variable **names only** below. Values never go in the repo, issues, PRs or logs.

## 1. The machine

- Node 22+ and git. Clone the repo, then install the lanes the service needs:
  ```sh
  for d in core chain agents; do npm ci --prefix $d; done
  ```
- Keypair files (Solana CLI JSON format, 64 numbers), kept outside the repo or in `agents/.keys/` (gitignored), mode 600:
  - the **fee payer**: a little devnet SOL; it pays the agents' transaction fees;
  - the **team seller**: the seller of the site's Team listings (the Trip planner). It accepts the fee deals and
    delivers the final product hash. It must be the listing's seller, or the service refuses the fee deal (`FEE_DEAL_SELLER`).
- Devnet only: the service refuses a mainnet RPC.

## 2. The mission service's environment

| Variable | Required | What it is |
|---|---|---|
| `MISSION_SERVICE_TOKEN` | yes | Bearer token (at least 32 characters). The same value goes on Vercel. |
| `DEAL_VERIFIER` | yes | The marketplace verifier's **address**, named on every agent deal. |
| `BROKER_MASTER_KEY` | yes | 64 hex characters; seals and unseals provider credentials in the broker's vault. |
| `MISSION_FEE_PAYER` | yes | Path to the fee payer's keypair file. |
| `MISSION_TEAM_SELLER` | for fee deals | Path to the team seller's keypair file. Without it, fee deals are refused. |
| `BROKER_CREDENTIALS` | no | Path to a JSON array of sealed provider credentials; the mock providers get placeholders without it. |
| `AI_PROVIDER` | no | `simulated` (the labelled Simulated AI demo, no key) or `anthropic` (Claude). Unset: Claude if `ANTHROPIC_API_KEY` is set, else the deterministic workers. |
| `ANTHROPIC_API_KEY` | for Claude | Sealed into the broker's vault at start and removed from the process environment; workers never see it. |
| `LLM_MODEL` | no | Model id for the Claude workers (default `claude-opus-5-5`). |
| `MISSION_STORE` | no | Directory for each mission's public view (never a key), so the site still shows missions after a restart (default `agents/demo-runs/missions`). |
| `DEAL_RPC_URL` | no | Devnet RPC (default: the public devnet endpoint). Use a dedicated RPC for a demo day. |
| `DEAL_MINT` | no | Settlement token (default: Circle devnet USDC). Must match the site's. |
| `HOST` / `PORT` | no | Listen address (default `127.0.0.1:3320`). Keep it on localhost and put a tunnel or proxy in front. |

## 3. Run it as a service

Start command, from the repo root:
```sh
npm run serve:missions --prefix agents
```

**Linux (systemd).** `/etc/systemd/system/fiducia-missions.service`:
```ini
[Unit]
Description=Fiducia mission service
After=network-online.target

[Service]
WorkingDirectory=/opt/solana-hackathon
EnvironmentFile=/etc/fiducia/missions.env
ExecStart=/usr/bin/npm run serve:missions --prefix agents
Restart=on-failure
RestartSec=5
User=fiducia
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```
`/etc/fiducia/missions.env` holds the variables from section 2, one `NAME=value` per line, owned by root, mode 600. Then:
`systemctl daemon-reload && systemctl enable --now fiducia-missions && journalctl -u fiducia-missions -f`.

**macOS (launchd)** or **pm2** work the same way: one long-running process, the variables from a file only the
service user can read, and restart on failure.

**Restarts.** Missions still running when the process stops come back on the site as `interrupted` (from
`MISSION_STORE`); finished ones still show in full. Running agents do not resume: hire again.

## 4. Reach it from Vercel

The site calls the service from its server routes only (the browser never sees the URL or the token). Give it a
public **HTTPS** URL in front of `127.0.0.1:3320`, for example:
- a Cloudflare Tunnel or Tailscale Funnel to `http://127.0.0.1:3320`, or
- a reverse proxy (Caddy or nginx) with TLS on a VPS.

Every request needs `Authorization: Bearer <MISSION_SERVICE_TOKEN>`; anything else gets 401. Check it from your
laptop: a GET of `<url>/missions/<any address>` with the token answers `404 UNKNOWN_MISSION` (reachable and
authorized); without the token, `401`.

## 5. Vercel environment (Project Settings -> Environment Variables)

Server only (never prefixed `NEXT_PUBLIC_`):

| Variable | Needed for |
|---|---|
| `DEAL_CLUSTER` | `devnet` (mainnet is refused) |
| `DEAL_RPC_URL` | the server's RPC (optional) |
| `DEAL_MINT` | settlement token (optional; default Circle devnet USDC) |
| `MISSION_SERVICE_URL` | the HTTPS URL from section 4: hire, missions page, demo |
| `MISSION_SERVICE_TOKEN` | the same token as the service: hire, missions page, demo |
| `DEMO_BUYER_KEY` | "Try the demo": the devnet demo buyer's keypair (64-number JSON). Unset = the button is hidden. |
| `ANTHROPIC_API_KEY` | drafting on /sell (optional; the site's own drafting, separate from the agents' key) |
| `DEAL_VERIFIER_KEY` | the verifier routes |
| `DEAL_FAUCET_KEY` | the test-token faucet |
| `DEAL_ASSESSOR_KEY` | the assessor (sell flow) |
| `DEAL_CUSTODY_KEY` | data custody (sell flow) |
| `BLOB_READ_WRITE_TOKEN` | listing documents and custody storage on Vercel |

Public (built into the browser bundle; never a secret):

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_DEAL_CLUSTER` | cluster shown and used by the browser |
| `NEXT_PUBLIC_DEAL_RPC_URL` | the browser's RPC |
| `NEXT_PUBLIC_DEAL_MINT` | settlement token in the browser (must match `DEAL_MINT`) |
| `NEXT_PUBLIC_DEMO_MISSION` | a finished demo mission's address: shows "Watch the demo mission" (read-only) |
| `NEXT_PUBLIC_DEMO_FEE_DEAL` | that mission's fee deal |

After changing variables, redeploy. `GET /api/health` lists which capabilities are configured (`missions`, `demo`, ...)
without their values.

## 6. The demo buyer ("Try the demo")

- A fresh keypair used only for this, on devnet. Fund it with devnet SOL (fees and mission rent) and test USDC.
- On its first demo, the site creates its on-chain budget policy at the demo caps (20 USDC a day, 10 USDC per deal).
  If the key already has a larger policy, every demo is refused (`DEMO_POLICY_TOO_LARGE`): use a fresh key.
- Each demo mission has a fixed 2 USDC budget. Limits: 2 new demo missions per IP per hour, 20 per day per instance,
  20 approvals or releases per IP per hour. The key approves and releases only missions whose on-chain buyer is itself.

## 7. Before recording

1. Start the service; check section 4's 404/401.
2. Set the Vercel variables; redeploy; check `/api/health` shows `missions: true` (and `demo: true` if used).
3. Run one scripted mission on the service host so it lands in `MISSION_STORE`:
   `AI_PROVIDER=simulated npm run demo:mission --prefix agents -- --step`
4. Put the printed mission and fee deal into `NEXT_PUBLIC_DEMO_MISSION` / `NEXT_PUBLIC_DEMO_FEE_DEAL`; redeploy;
   open `/missions?m=<mission>&fee=<deal>` and check the plan, approvals, spends (including the refusal), results
   and delivery appear.
