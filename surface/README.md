# surface — procurement layer demo

Ask → Find → Draft terms → Lock → Deliver → Settle, on the `deal_escrow` program (Solana devnet).

```sh
npm install --prefix core && npm install --prefix chain && npm install --prefix surface
# 1. fund the Solana CLI wallet (`solana address`) with devnet SOL: https://faucet.solana.com
# 2. deploy the program (once; needs ~2 SOL):
solana program deploy chain/program/deal_escrow.so --program-id chain/anchor/target/deploy/deal_escrow-keypair.json -u devnet
# 3. seller keys, test USDC mint, token accounts -> surface/.keys (gitignored, devnet only):
npm run setup:devnet --prefix surface
# 4. run (ANTHROPIC_API_KEY optional: Claude drafts terms and produces deliverables; otherwise rules + placeholder)
npm start --prefix surface   # http://localhost:3000
```

Local instead of devnet: start `solana-test-validator --bpf-program CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV chain/program/deal_escrow.so`,
then run step 3 with `SOLANA_RPC_URL=http://127.0.0.1:8899`.

The server wallet is the buyer and pays all fees; sellers sign without SOL. "USDC" here is a test mint we control.
Tests: `npm test --prefix surface` (chain mocked); the program itself is tested in `chain/test` with LiteSVM.
