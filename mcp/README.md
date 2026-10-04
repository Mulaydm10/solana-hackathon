# mcp — MCP server for escrowed deals on Solana

Run as `npx deal-mcp` once published (name is a placeholder until the package name is chosen).
Infrastructure only so far: one read-only tool, `program_info`.

## Configure (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DEAL_CLUSTER` | `devnet` | `devnet` or `localnet`; mainnet is refused |
| `DEAL_RPC_URL` | the cluster's public RPC | your RPC endpoint |
| `DEAL_KEYPAIR` | none | path to **your agent's own** keypair; only signing tools need it. The package never ships or fetches keys |

## Add a tool (one file + one line)

1. Create `src/tools/<name>.ts` that default-exports `defineTool({ name, description, input, writes, run })`.
   `input` is a zod shape; `run` returns `ok({...})` or `refuse("REASON_CODE", "message")` — never throw for expected outcomes.
2. Add it to `src/tools/index.ts`.
3. `npm test` — the registry tests fail if step 2 is missing, the name isn't unique snake_case, or the result shape is wrong.

## Test

`npm test` = typecheck → unit tests → bundle (`dist/cli.js`, self-contained) → smoke test that copies the bundle into an
empty directory and drives it with a real MCP client over stdio (initialize, list tools, call a tool).
