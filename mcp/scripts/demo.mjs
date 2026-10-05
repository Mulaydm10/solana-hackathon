// Scripted demo: drives the BUILT server (dist/cli.js) over stdio with a real MCP client, the same way Claude
// Desktop or Claude Code would, and prints each tool call and its result. Read-only unless --buy is passed.
//
//   npm run build && node scripts/demo.mjs            # wallet, search, inspect a listing
//   node scripts/demo.mjs --buy                       # also: policy (if missing) and buy the cheapest attested data listing
//
// Configuration is the server's own environment (DEAL_KEYPAIR, DEAL_SITE_URL, DEAL_VERIFIER, ...), passed through.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const buy = process.argv.includes("--buy");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "fiducia-demo", version: "0" });

async function call(name, args = {}) {
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  console.log(JSON.stringify(body, null, 2).split("\n").slice(0, 40).join("\n"));
  return body;
}

await client.connect(transport);
try {
  const { tools } = await client.listTools();
  console.log(`connected: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`);
  await call("program_info");
  const wallet = await call("my_wallet");
  if (wallet.ok && wallet.data.next === "get_test_funds") await call("get_test_funds");
  const found = await call("find_listings", { kind: "Data" });
  const listings = found.ok ? found.data.listings : [];
  // The cheapest attested listing (only attested listings can be bought).
  const pick = listings.filter((l) => l.attested).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)))[0]?.address;
  if (!pick) {
    console.log("\nno attested data listing found; stopping here");
  } else {
    const l = await call("get_listing", { listing: pick });
    if (buy && l.ok && l.data.buyable) {
      const w = await call("my_wallet");
      if (w.ok && !w.data.policy) await call("setup_policy", { daily_budget_usdc: "50", max_price_usdc: "20" });
      const b = await call("buy", { listing: pick });
      if (b.ok) await call("deal_status", { deal: b.data.deal });
    } else if (buy) console.log("\nthat listing is not buyable; skipping the purchase");
  }
} finally {
  await client.close();
}
