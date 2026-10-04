// Runs the BUILT bundle the way `npx` would: copied alone into an empty directory (no node_modules),
// then driven by a real MCP client over stdio. Proves the package is self-contained and speaks MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "deal-mcp-"));
const cli = join(dir, "cli.js");
cpSync(new URL("../dist/cli.js", import.meta.url), cli);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("--version and --help work without any dependencies installed", () => {
  assert.match(execFileSync(process.execPath, [cli, "--version"], { cwd: dir }).toString(), /^\d+\.\d+\.\d+/);
  assert.match(execFileSync(process.execPath, [cli, "--help"], { cwd: dir }).toString(), /DEAL_KEYPAIR/);
});

test("refuses to start on mainnet", () => {
  assert.throws(() => execFileSync(process.execPath, [cli], { cwd: dir, env: { ...process.env, DEAL_CLUSTER: "mainnet-beta" }, stdio: "pipe" }));
});

test("MCP handshake: initialize, list tools, call program_info", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], cwd: dir, env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "program_info"));
    const res = await client.callTool({ name: "program_info", arguments: {} });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.data.cluster, "devnet");
  } finally {
    await client.close();
  }
});
