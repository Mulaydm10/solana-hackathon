# mcp — MCP server for escrowed deals on Solana

Run as `npx deal-mcp` once published (name is a placeholder until the package name is chosen).
Tools for an AI agent to buy data, services and agent teams under on-chain escrow, signing with its own key:

| Tool | Signs | What it does |
|---|---|---|
| `program_info` | no | Program id, network, deal statuses, refusal codes |
| `my_wallet` | no | This agent's address, SOL, USDC, its spending policy, and the next step to take |
| `get_test_funds` | no (devnet) | Devnet SOL (airdrop) and test USDC (the site's faucet) for the agent's own wallet |
| `find_listings` | no | Search the marketplace (ranked by verified fields; needs `DEAL_SITE_URL`) |
| `get_listing` | no | One listing from chain: price, content hash, attestation, the seller's scored reputation |
| `setup_policy` | yes | Create this agent's on-chain spending policy (daily budget, max price) once |
| `buy` | yes | Buy from an attested listing under escrow at its listed price |
| `deal_status` | no | Follow a deal |
| `release` | yes | Pay for a delivery, naming the delivery hash you checked |
| `challenge` | yes | Dispute a delivery; the deal's independent verifier decides |
| `hire_team` | no | Returns the link a **human** opens to fund a team and approve its stages in their own wallet |
| `mission_status` | no | Follow a hired team's mission: chain facts, plus the team's progress from the site |

No tool can approve a stage gate, add a mandate or raise a cap: those are the human's, in their own wallet (a test
enforces it). Refusals are normal results with a reason code (the program's own error names).

## Run it for the demo (devnet, today)

The package is not on npm yet, so run the local build:

```bash
for d in core chain agents mcp; do (cd $d && npm ci); done
npm run build --prefix mcp                       # -> mcp/dist/cli.js, one self-contained file
solana-keygen new -o ~/.config/fiducia/agent.json --no-bip39-passphrase   # the agent's OWN key (devnet only)
```

**Claude Code:**

```bash
claude mcp add fiducia \
  -e DEAL_KEYPAIR=$HOME/.config/fiducia/agent.json \
  -e DEAL_SITE_URL=https://fiducia-orpin.vercel.app \
  -e DEAL_ASSESSOR=EvR4wU8jfNeRLwHiDv8DoCqkSJ8w8nWwhQEXUg95PyKY \
  -- node /ABSOLUTE/PATH/solana-hackathon/mcp/dist/cli.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fiducia": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/solana-hackathon/mcp/dist/cli.js"],
      "env": {
        "DEAL_KEYPAIR": "/ABSOLUTE/PATH/.config/fiducia/agent.json",
        "DEAL_SITE_URL": "https://fiducia-orpin.vercel.app",
        "DEAL_ASSESSOR": "EvR4wU8jfNeRLwHiDv8DoCqkSJ8w8nWwhQEXUg95PyKY"
      }
    }
  }
}
```

Add `DEAL_VERIFIER=<the marketplace verifier address>` to make purchases challengeable (without it `buy` still
works, but the deal has no verifier).

Then ask the agent, for example: *"Check my wallet, get test funds if needed, set a 50 USDC daily budget with a
20 USDC max price, then find the cheapest attested dataset and buy it."* The agent calls `my_wallet` →
`get_test_funds` → `setup_policy` → `find_listings` → `get_listing` → `buy` → `deal_status`, and the program
enforces the budget, not the agent.

### Demo: an agent hires a team, the human approves, the agent follows it (3 steps)

1. Ask the agent: *"Find an agent team that plans trips and hire it to plan 3 days in Lisbon with a 5 USDC budget."*
   It calls `find_listings` (kind `Team`) and then `hire_team`, which returns an approval link. **No tool signs anything here.**
2. Open the link and sign in your own wallet: fund the mission, the agents' mandates, and each stage when its plan
   appears. Copy the mission address the page shows.
3. Ask the agent: *"Follow mission `<address>`."* `mission_status` returns the chain's facts (budget, spent, stages
   approved) and the team's progress from the site: the stage waiting for your approval, every spend (including ones
   the program refused, such as `OverPerTxCap`), the agents' results (marked untrusted) and the delivered product hash.
   Releasing the fee is yours too, on the mission page.

**Scripted run** (no AI client needed, same MCP protocol): with the same variables exported,
`npm run demo --prefix mcp` (read-only) or `node mcp/scripts/demo.mjs --buy` (sets a policy if missing and buys).

## Configure (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DEAL_CLUSTER` | `devnet` | `devnet` or `localnet`; mainnet is refused |
| `DEAL_RPC_URL` | the cluster's public RPC | your RPC endpoint |
| `DEAL_KEYPAIR` | none | path to **your agent's own** keypair; only signing tools need it. The package never ships or fetches keys |
| `DEAL_MINT` | Circle devnet USDC | the token deals settle in |
| `DEAL_VERIFIER` | none | the marketplace verifier named on purchases (without one, a deal cannot be challenged) |
| `DEAL_SITE_URL` | none | the marketplace site, for search and for links a human must open |

## Add a tool (one file + one line)

1. Create `src/tools/<name>.ts` that default-exports `defineTool({ name, description, input, writes, run })`.
   `input` is a zod shape; `run` returns `ok({...})` or `refuse("REASON_CODE", "message")` — never throw for expected outcomes.
2. Add it to `src/tools/index.ts`.
3. `npm test` — the registry tests fail if step 2 is missing, the name isn't unique snake_case, or the result shape is wrong.

## Test

`npm test` = typecheck → unit tests → bundle (`dist/cli.js`, self-contained) → smoke test that copies the bundle into an
empty directory and drives it with a real MCP client over stdio (initialize, list tools, call a tool).
