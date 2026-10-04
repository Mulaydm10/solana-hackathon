import { DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_ERRORS, STATUS_NAMES } from "@deal/chain";
import { defineTool, ok } from "../tool.ts";

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
      rpcUrl: config.rpcUrl,
      dealStatuses: [...STATUS_NAMES],
      refusalReasons: [...PROGRAM_ERRORS],
      signer: config.keypairPath ? "configured" : "none (read-only tools only)",
    });
  },
});
