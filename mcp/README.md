# mcp — MCP server for escrowed deals on Solana

Run as `npx deal-mcp` once published (name is a placeholder until the package name is chosen).
Tools for an AI agent to buy data, services and agent teams under on-chain escrow, signing with its own key:

| Tool | Signs | What it does |
|---|---|---|
| `program_info` | no | Program id, network, deal statuses, refusal codes |
| `find_listings` | no | Search the marketplace (ranked by verified fields; needs `DEAL_SITE_URL`) |
| `get_listing` | no | One listing from chain: price, content hash, attestation, the seller's scored reputation |
| `setup_policy` | yes | Create this agent's on-chain spending policy (daily budget, max price) once |
| `buy` | yes | Buy from an attested listing under escrow at its listed price |
| `deal_status` | no | Follow a deal |
| `release` | yes | Pay for a delivery, naming the delivery hash you checked |
| `challenge` | yes | Dispute a delivery; the deal's independent verifier decides |
| `hire_team` | no | Returns the link a **human** opens to fund a team and approve its stages in their own wallet |
| `mission_status` | no | Follow a hired team's mission |

No tool can approve a stage gate, add a mandate or raise a cap: those are the human's, in their own wallet (a test
enforces it). Refusals are normal results with a reason code (the program's own error names).

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
