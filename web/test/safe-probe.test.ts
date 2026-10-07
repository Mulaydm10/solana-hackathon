// #197: the assessor's probe refuses every address that is not on the public internet, checks every DNS answer,
// and connects to exactly the checked address with TLS verified against the hostname (no rebinding). Stub resolver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, pinnedOptions, safeProbe, type PinnedRequest, type Resolved } from "../lib/safe-probe.ts";

test("private, loopback, link-local, CGNAT, multicast and reserved addresses are not public (IPv4 and IPv6)", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::1%en0", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1",
    "2002:0a00:0001::1", "2002:c0a8:0101::1", "::10.0.0.1", "not-an-ip", "", "1.2.3", "300.1.1.1",
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
});

test("public addresses pass, including IPv4-mapped, NAT64 and 6to4 forms of a public IPv4", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

function harness(answers: Resolved[] | Error) {
  const sent: { url: string; pinned: Resolved; redirect?: string }[] = [];
  const request: PinnedRequest = async (url, init, pinned) => (sent.push({ url: url.href, pinned, redirect: init.redirect }), new Response("{}", { status: 200 }));
  const probe = safeProbe(async () => { if (answers instanceof Error) throw answers; return answers; }, request);
  return { probe, sent };
}
const reason = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

test("probe: refuses http, credentials, local names, private literals and any private DNS answer; nothing is requested", async () => {
  const pub: Resolved = { address: "93.184.216.34", family: 4 };
  const cases: [string, Resolved[] | Error, string][] = [
    ["http://api.example.com/x", [pub], "HTTPS_ONLY"],
    ["https://user:pw@api.example.com/x", [pub], "NO_CREDENTIALS"],
    ["https://localhost/x", [pub], "PRIVATE_HOST"],
    ["https://metadata.internal/x", [pub], "PRIVATE_HOST"],
    ["https://169.254.169.254/latest/meta-data", [], "PRIVATE_ADDRESS"],
    ["https://[::ffff:10.0.0.1]/x", [], "PRIVATE_ADDRESS"],
    ["https://evil.example.com/x", [{ address: "10.0.0.5", family: 4 }], "PRIVATE_ADDRESS"],
    ["https://mixed.example.com/x", [pub, { address: "127.0.0.1", family: 4 }], "PRIVATE_ADDRESS"],
    ["https://v6.example.com/x", [{ address: "fd00::1", family: 6 }], "PRIVATE_ADDRESS"],
    ["https://gone.example.com/x", new Error("ENOTFOUND"), "DNS_FAILED"],
    ["https://empty.example.com/x", [], "DNS_FAILED"],
    ["not a url", [pub], "BAD_URL"],
  ];
  for (const [url, answers, code] of cases) {
    const h = harness(answers);
    assert.equal(await reason(h.probe(url, { method: "POST" })), code, url);
    assert.equal(h.sent.length, 0, `${url} must not be requested`);
  }
});

test("probe: a public host is requested once, pinned to the checked address, without following redirects", async () => {
  const h = harness([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
  const r = await h.probe("https://api.example.com/v1/quote?x=1", { method: "POST", body: "{}" });
  assert.equal(r.status, 200);
  assert.deepEqual(h.sent, [{ url: "https://api.example.com/v1/quote?x=1", pinned: { address: "93.184.216.34", family: 4 }, redirect: "manual" }]);
});

test("pinned options: the socket goes to the checked address while TLS checks the certificate for the hostname", async () => {
  const o = pinnedOptions(new URL("https://api.example.com:8443/v1/quote?x=1"), { method: "POST", headers: { "content-type": "application/json" } }, { address: "93.184.216.34", family: 4 });
  assert.equal(o.hostname, "api.example.com");
  assert.equal(o.servername, "api.example.com", "SNI and certificate check use the hostname");
  assert.equal(o.port, 8443);
  assert.equal(o.path, "/v1/quote?x=1");
  assert.equal(o.method, "POST");
  assert.equal((o.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal((o as { rejectUnauthorized?: boolean }).rejectUnauthorized, undefined, "certificate verification stays on");
  const viaLookup = await new Promise<unknown[]>((res) => (o.lookup as unknown as (h: string, opts: object, cb: (...a: unknown[]) => void) => void)("rebound.example.com", {}, (...a) => res(a)));
  assert.deepEqual(viaLookup, [null, "93.184.216.34", 4], "whatever DNS says now, the connection uses the checked address");
  const all = await new Promise<unknown[]>((res) => (o.lookup as unknown as (h: string, opts: object, cb: (...a: unknown[]) => void) => void)("x", { all: true }, (...a) => res(a)));
  assert.deepEqual(all, [null, [{ address: "93.184.216.34", family: 4 }]]);
});
