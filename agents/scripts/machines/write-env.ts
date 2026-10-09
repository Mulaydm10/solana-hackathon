// Writes the site's /machines server env (contracts/web.md) to a 0600 file, for `vercel env add` (#228). Never prints
// a value: only the variable names. Refuses until fleet-setup and activate have both run.
//
//   node --import tsx scripts/machines/write-env.ts OUT_FILE [--keys-dir DIR]
//   env (optional overrides): PEAQ_RPC_URL, PEAQ_EXPLORER_TX_URL
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFleetKeys, machineEnv, readFleetState, writeEnvFile } from "../../src/machines/setup.ts";

const args = process.argv.slice(2);
const out = args.find((x, i) => !x.startsWith("--") && args[i - 1] !== "--keys-dir");
const dir = args.includes("--keys-dir") ? args[args.indexOf("--keys-dir") + 1]! : join(homedir(), ".config", "fiducia", "machines");
if (!out) {
  console.error("✗ usage: write-env.ts OUT_FILE [--keys-dir DIR]");
  process.exit(1);
}
// A state with a `network` section (network-setup, peaq v2) also writes the v2 variables; otherwise the v1 env as before.
const state = readFleetState(dir);
const { keys } = state.network ? loadFleetKeys(dir, false, { network: true }) : loadFleetKeys(dir, false);
// RPC and explorer follow the network the machines were activated on (agung or peaq mainnet), unless overridden.
const env = machineEnv(keys, state, { peaqRpcUrl: process.env.PEAQ_RPC_URL, explorerTxUrl: process.env.PEAQ_EXPLORER_TX_URL });
writeEnvFile(out, env);
console.log(`wrote ${Object.keys(env).length} variables to ${out} (0600): ${Object.keys(env).join(", ")}`);
