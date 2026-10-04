// The main entry is consumed by bundlers (web, mcp): it must not reach Node built-ins or file paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("main entry has no Node built-ins or import.meta file paths", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "node:/);
  assert.doesNotMatch(src, /import\.meta\.url/);
});

test("node entry still exposes the program binary path", async () => {
  const { PROGRAM_SO } = await import("../src/node.ts");
  assert.match(PROGRAM_SO, /deal_escrow\.so$/);
});
