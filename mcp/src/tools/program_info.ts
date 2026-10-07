import { DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_ERRORS, STATUS_NAMES } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";

/** The RPC as it may be shown: scheme, host and path only. API keys often live in the query string or credentials. */
export function shownRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.search || u.username || u.password || u.hash;
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}${hidden ? " (query/credentials hidden)" : ""}`;
  } catch {
    return "(not a URL)";
  }
}

/** Which escrow program and network this server talks to. Offline: reads nothing from the chain. */
export default defineTool({
  name: "program_info",
  description:
    "Describe the escrow program this server uses: program id, network, deal statuses and refusal reason codes. Call first to learn the vocabulary of deal states and refusals.",
  input: {},
  writes: false,
  async run(_args, { config }) {
    return ok({
      program: DEAL_ESCROW_PROGRAM_ADDRESS,
      cluster: config.cluster,
      rpcUrl: shownRpcUrl(config.rpcUrl),
      dealStatuses: [...STATUS_NAMES],
      refusalReasons: [...PROGRAM_ERRORS],
      signer: config.keypairPath ? "configured" : "none (read-only tools only)",
    });
  },
});
