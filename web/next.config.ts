import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The shared lanes (core, chain) are TypeScript sources linked from outside this directory, so the
// bundler root is the repo root and they are transpiled like app code.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const config: NextConfig = {
  transpilePackages: ["@deal/core", "@deal/chain", "@deal/agents"],
  // The peaq SDK (machines, #229) is loaded by Node at runtime, never bundled: one of its dependencies ships assets
  // the bundler cannot place. Server only; it is a web dependency so it resolves from here.
  serverExternalPackages: ["@peaqos/peaq-os-sdk"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default config;
