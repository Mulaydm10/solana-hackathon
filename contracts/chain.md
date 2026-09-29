# chain - contract

Exposes (Solana devnet, USDC):
- pay(x402 requirements, payer) -> signature; refused by the chain if delegation is over-limit or revoked
- approve(child, cap) / revoke(child) via SPL Token delegate (one token account per child agent)
- verify(signature, expected) -> boolean via RPC getTransaction
Consumed by surface through a payment-backend interface; core never imports chain.
