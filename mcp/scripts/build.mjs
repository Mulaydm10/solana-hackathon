// Bundles the CLI into one self-contained file (dist/cli.js). Workspace packages (@deal/core,
// @deal/chain) and all libraries are inlined, so the published package has no runtime dependencies
// and `npx` needs nothing else. The smoke test runs the bundle from an empty directory to prove it.
import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = new URL("../dist/cli.js", import.meta.url).pathname;
await build({
  entryPoints: [new URL("../src/cli.ts", import.meta.url).pathname],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "linked",
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
chmodSync(out, 0o755);
