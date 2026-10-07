// The assessor's probe to a seller's service endpoint (#197, #196 item 1), safe against server-side request forgery.
// The host is resolved first and refused if any address is private, loopback, link-local, CGNAT, multicast or
// reserved (IPv4, IPv6, IPv4-mapped, NAT64, 6to4); then the request connects to exactly the checked address (a pinned
// lookup, so no DNS rebinding between check and connect), with TLS verified against the hostname. https only, no
// credentials in the URL, no redirects, and the answer is capped. Server only.
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { Probe } from "./sell";

export type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Resolved[]>;
export type PinnedRequest = (url: URL, init: RequestInit, pinned: Resolved) => Promise<Response>;

const MAX_BODY = 1_000_000;

// ---------- address checks ----------

function v4Bytes(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? b : null;
}

/** 16 bytes of an IPv6 address (with "::" and an embedded dotted IPv4), or null. */
function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  let tail: number[] = [];
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = v4Bytes(m[2]!);
    if (!v4) return null;
    tail = v4;
    s = m[1]!.endsWith("::") ? m[1]! : m[1]!.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string) => (h ? h.split(":") : []);
  const head = words(halves[0]!), rest = halves.length === 2 ? words(halves[1]!) : [];
  const total = 8 - tail.length / 2;
  if (halves.length === 1 && head.length !== total) return null;
  const zeros = total - head.length - rest.length;
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null;
  const all = [...head, ...Array(halves.length === 2 ? zeros : 0).fill("0"), ...rest];
  const out: number[] = [];
  for (const w of all) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    const n = parseInt(w, 16);
    out.push(n >> 8, n & 0xff);
  }
  return [...out, ...tail].length === 16 ? [...out, ...tail] : null;
}

const inV4 = (b: number[], net: number[], bits: number) => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((b[i]! & mask) !== (net[i]! & mask)) return false;
  }
  return true;
};

/** IPv4 ranges that are not the public internet (RFC 6890 and friends). */
const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

export function isPublicV4(ip: string): boolean {
  const b = v4Bytes(ip);
  return !!b && !V4_BLOCKED.some(([net, bits]) => inV4(b, net, bits));
}

/** True only for a globally routable unicast address; anything unparsable is not public. */
export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip.replace(/%.*$/, ""));
  if (fam === 4) return isPublicV4(ip);
  if (fam !== 6) return false;
  const b = v6Bytes(ip);
  if (!b) return false;
  const v4 = (o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16) || (zero(0, 15) && b[15] === 1)) return false; // :: and ::1
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(v4(12)); // ::ffff:a.b.c.d
  if (zero(0, 12)) return false; // deprecated IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zero(4, 12) ? isPublicV4(v4(12)) : false; // NAT64 64:ff9b::/96 (well-known) checks the embedded IPv4; 64:ff9b:1::/48 local
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(v4(2)); // 6to4 2002::/16 embeds an IPv4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation 2001:db8::/32
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return false; // discard 100::/64
  if ((b[0]! & 0xfe) === 0xfc) return false; // unique local fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return false; // site-local fec0::/10 (deprecated)
  if (b[0] === 0xff) return false; // multicast
  return (b[0]! & 0xe0) === 0x20; // global unicast is 2000::/3
}

// ---------- the probe ----------

const refuse = (code: string, message: string) => Promise.reject(Object.assign(new Error(message), { code }));

/** Resolves every address of the host (A and AAAA). */
export const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({ address: r.address, family: r.family as 4 | 6 }));

/** Node https options that connect only to `pinned` while TLS still checks the certificate against the hostname. */
export function pinnedOptions(url: URL, init: RequestInit, pinned: Resolved): RequestOptions {
  const lookup = ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as unknown as LookupFunction;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  return {
    protocol: "https:", hostname: url.hostname.replace(/^\[|\]$/g, ""), servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
    port: url.port ? Number(url.port) : 443, path: `${url.pathname}${url.search}`, method: init.method ?? "GET", headers, lookup, agent: false,
    signal: init.signal ?? undefined,
  };
}

/** Production request: node https with the pinned lookup; redirects are returned as they are, never followed. */
export const pinnedRequest: PinnedRequest = (url, init, pinned) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(pinnedOptions(url, init, pinned), (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(Object.assign(new Error("answer too large"), { code: "TOO_LARGE" })); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    else if (init.body != null) { req.destroy(); reject(new Error("only string bodies")); return; }
    req.end();
  });

/** The assessor's probe: https only, public addresses only, pinned to the checked address. */
export function safeProbe(resolve: Resolver = systemResolver, request: PinnedRequest = pinnedRequest): Probe {
  return async (raw, init) => {
    let url: URL;
    try { url = new URL(raw); } catch { return refuse("BAD_URL", "not a URL"); }
    if (url.protocol !== "https:") return refuse("HTTPS_ONLY", "https only");
    if (url.username || url.password) return refuse("NO_CREDENTIALS", "no credentials in the URL");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host || /^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return refuse("PRIVATE_HOST", "the host is not on the public internet");
    let addrs: Resolved[];
    if (isIP(host)) addrs = [{ address: host, family: isIP(host) as 4 | 6 }];
    else {
      try { addrs = await resolve(host); } catch { return refuse("DNS_FAILED", "the host did not resolve"); }
    }
    if (!addrs.length) return refuse("DNS_FAILED", "the host did not resolve");
    // Every address must be public: a mixed answer could be steered to the private one.
    if (!addrs.every((a) => isPublicAddress(a.address))) return refuse("PRIVATE_ADDRESS", "the host resolves to an address that is not on the public internet");
    return request(url, { ...init, redirect: "manual" }, addrs[0]!);
  };
}
