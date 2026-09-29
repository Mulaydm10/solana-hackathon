# core - contract

Exposes (chain-agnostic, no network/chain imports):
- grant(parent, child, cap) -> allowance; child authority never exceeds parent's remaining authority
- revoke(agent) -> cuts off agent and its whole subtree
- check(agent, amount) -> ok | refusal with reason code OVER_LIMIT | REVOKED | PARENT_REVOKED
