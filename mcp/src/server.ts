// Builds the MCP server from the tool registry. Tool results are returned both as JSON text (for
// any client) and as structured content. Unexpected exceptions become INTERNAL errors; they never
// crash the server or leak a stack trace to the agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.ts";
import type { AnyTool, ChainAccess, ToolContext, ToolResult } from "./tool.ts";
import { openChain } from "./chain.ts";
import { TOOLS } from "./tools/index.ts";

declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

export function createServer(config: Config, tools: readonly AnyTool[] = TOOLS, chain?: () => Promise<ChainAccess>): McpServer {
  const server = new McpServer({ name: "deal-mcp", version: VERSION });
  // The chain is opened once, on the first tool that needs it.
  let opened: Promise<ChainAccess> | undefined;
  const ctx: ToolContext = { config, chain: chain ?? (() => (opened ??= openChain(config))) };
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: !tool.writes } },
      async (args: Record<string, unknown>) => {
        let result: ToolResult;
        let isError = false;
        try {
          result = await tool.run(args, ctx);
        } catch (e) {
          console.error(`[deal-mcp] ${tool.name} failed:`, e);
          result = { ok: false, reason: "INTERNAL", message: "The tool failed unexpectedly; no state change is assumed." };
          isError = true;
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError };
      },
    );
  }
  return server;
}
