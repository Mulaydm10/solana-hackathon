# surface - contract

Exposes:
- x402-gated HTTP server (returns 402 with payment requirements; verifies via chain)
- browser demo of grant / spend / refuse / revoke
- MCP server tools; refusals are normal results carrying a reason code, not errors
Depends on: core (rules), chain (payment backend interface).
