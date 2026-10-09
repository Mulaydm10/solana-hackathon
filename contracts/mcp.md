# mcp - contract

npm package, run as `npx <name>-mcp`, exposing an MCP server (stdio) to AI agents. Infrastructure only for now.

- Tools (planned): find services, draft terms, open / accept / deliver / release / challenge deals, deal status.
  Refusals are normal tool results carrying a reason code, never thrown errors.
- Signs with the agent's own local keypair (path from config or env). The package never ships or fetches keys.
- Bundled into a single file at build time so `@deal/core` and `@deal/chain` (workspace-local) need not be published.
- Verify: `npm test --prefix mcp` (unit tests + bundle smoke test).

## machine_status (#230, optional)

Read-only tool: the two simulated machines' peaq IDs, the robot's mandate left, recent charges, peaq event count or
MCR. No signing; existing tools unchanged.

## machine_status v2 (#275)

Adds the status fields of contracts/web.md "Machines v2" (network, scores, insurance, earnings) to the tool's output,
read from the same sources. Still read-only, no signing; existing fields unchanged.
