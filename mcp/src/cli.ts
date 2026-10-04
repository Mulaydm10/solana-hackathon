// Entry point for `npx deal-mcp`. stdout belongs to the MCP protocol: all logging goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { createServer, VERSION } from "./server.ts";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  process.stdout.write(
    [
      `deal-mcp ${VERSION} - MCP server for escrowed deals on Solana`,
      "",
      "Environment:",
      "  DEAL_CLUSTER   devnet (default) | localnet",
      "  DEAL_RPC_URL   RPC endpoint (default: the cluster's public endpoint)",
      "  DEAL_KEYPAIR   path to your agent's Solana keypair file (needed only by tools that sign)",
      "  DEAL_SITE_URL  the marketplace site (search, demand board, assessor and custody for publish_listing)",
      "  DEAL_ASSESSOR  the registered assessor to name on listings you publish",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const cfg = loadConfig(process.env);
if (!cfg.ok) {
  console.error(`[deal-mcp] ${cfg.reason}: ${cfg.message}`);
  process.exit(1);
}
const server = createServer(cfg.config);
await server.connect(new StdioServerTransport());
console.error(`[deal-mcp] ${VERSION} ready on stdio (${cfg.config.cluster})`);
