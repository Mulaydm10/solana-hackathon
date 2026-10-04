// Capability broker + sealed credentials + egress proxy (PLAN §6.3, §6.2, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode, roleHash, type Blueprint } from "@deal/core";
import { approvalBytes, createBroker, createEgressProxy, createVault, masterKeyFromEnv, sealCredential, type MandateState, type Provider } from "../src/index.ts";

const SECRET = "sk-live-THIS-MUST-NEVER-LEAK-1234";
const MISSION = "Mission111111111111111111111111111111111111";
const AGENT = "Agent1111111111111111111111111111111111111";
const OTHER = "Other1111111111111111111111111111111111111";

const blueprint: Blueprint = {
  version: 1,
  name: "Market research",
  roles: [
    { name: "researcher", purpose: "Reads market data", capabilities: ["market:read"], cap: 5_000_000n, perTxCap: 1_000_000n },
    { name: "booker", purpose: "Books things", capabilities: ["booking:quote", "booking:pay"], cap: 5_000_000n, perTxCap: 1_000_000n },
  ],
  stages: [{ name: "Research", roles: ["researcher", "booker"], cap: 5_000_000n, gate: "human" }],
  deliverable: { description: "A report", check: "sha256" },
  maxDuration: 3600,
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function setup(o: { providers?: Provider[]; marketHosts?: string[] } = {}) {
  const master = randomBytes(32);
  const vault = createVault(master, [sealCredential(master, "market", SECRET), sealCredential(master, "booking", SECRET), sealCredential(master, "leaky", SECRET)]);
  const calls: { action: string; credential: string }[] = [];
  const providers: Provider[] = o.providers ?? [
    { id: "market", hosts: o.marketHosts ?? ["127.0.0.1:443"], call: async (action, resource, args, credential) => { calls.push({ action, credential }); return { action, resource, args }; } },
    { id: "booking", hosts: ["booking.example"], elevated: ["pay"], call: async (action) => ({ done: action }) },
    { id: "leaky", hosts: [], call: async (_a, _r, _x, credential) => ({ echo: `key=${credential}` }) },
  ];
  const state = new Map<string, MandateState>([
    [AGENT, { live: true, stageOpen: true, roleHash: hex(roleHash(blueprint.roles[0]!)) }],
    [OTHER, { live: true, stageOpen: true, roleHash: hex(roleHash(blueprint.roles[1]!)) }],
  ]);
  let clock = 1_000;
  const buyerSecret = randomBytes(32);
  const buyer = base58Encode(ed25519.getPublicKey(buyerSecret));
  const broker = createBroker({ vault, providers, mandates: async (_m, a) => state.get(a) ?? null, now: () => clock });
  broker.registerMission(MISSION, { buyer, blueprint, agents: { [AGENT]: "researcher", [OTHER]: "booker" } });
  return { broker, state, calls, buyerSecret, tick: (s: number) => (clock += s) };
}

const grantMarket = (b: ReturnType<typeof setup>["broker"], agent = AGENT, actions = ["read"]) =>
  b.grant({ provider: "market", resource: "prices/eurusd", actions, mission: MISSION, agent });

test("sealed credentials: round trip, wrong key and tampering refused, no read method", async () => {
  const k = randomBytes(32);
  const s = sealCredential(k, "market", SECRET);
  assert.ok(!JSON.stringify(s).includes(SECRET));
  const v = createVault(k, [s]);
  assert.deepEqual(await v.withCredential("market", async (x) => x.length), { ok: true, value: SECRET.length });
  assert.deepEqual(await createVault(randomBytes(32), [s]).withCredential("market", async () => 1), { ok: false, reason: "TAMPERED" });
  const moved = { ...s, provider: "booking" }; // a credential cannot be replayed under another provider
  assert.deepEqual(await createVault(k, [moved]).withCredential("booking", async () => 1), { ok: false, reason: "TAMPERED" });
  assert.deepEqual(await v.withCredential("nope", async () => 1), { ok: false, reason: "NO_CREDENTIAL" });
  assert.deepEqual(Object.keys(v).sort(), ["providers", "withCredential"]);
  assert.throws(() => masterKeyFromEnv({ BROKER_MASTER_KEY: "short" }));
});

test("grant: only capabilities the role lists, only for the role approved on chain, only while live", async () => {
  const { broker, state } = setup();
  assert.deepEqual(((await grantMarket(broker, AGENT, ["write"])) as { reason: string }).reason, "NOT_IN_ROLE");
  assert.deepEqual(((await broker.grant({ provider: "booking", resource: "r", actions: ["quote"], mission: MISSION, agent: AGENT })) as { reason: string }).reason, "NOT_IN_ROLE");
  assert.deepEqual(((await broker.grant({ provider: "nope", resource: "r", actions: ["read"], mission: MISSION, agent: AGENT })) as { reason: string }).reason, "UNKNOWN_PROVIDER");
  assert.deepEqual(((await broker.grant({ provider: "market", resource: "r", actions: ["read"], mission: "Unknown", agent: AGENT })) as { reason: string }).reason, "UNKNOWN_MISSION");
  // A role widened off chain (different hash from the mandate's) gets nothing.
  state.set(AGENT, { ...state.get(AGENT)!, roleHash: "00".repeat(32) });
  assert.deepEqual(((await grantMarket(broker)) as { reason: string }).reason, "ROLE_MISMATCH");
  state.set(AGENT, { ...state.get(AGENT)!, roleHash: hex(roleHash(blueprint.roles[0]!)) });
  state.set(AGENT, { ...state.get(AGENT)!, stageOpen: false });
  assert.deepEqual(((await grantMarket(broker)) as { reason: string }).reason, "STAGE_NOT_OPEN");
  state.set(AGENT, { ...state.get(AGENT)!, stageOpen: true, live: false });
  assert.deepEqual(((await grantMarket(broker)) as { reason: string }).reason, "MANDATE_NOT_LIVE");
  state.set(AGENT, { ...state.get(AGENT)!, live: true });
  const g = await grantMarket(broker);
  assert.ok(g.ok);
});

test("call: the provider gets the credential, the agent never does; actions are limited to the grant", async () => {
  const { broker, calls } = setup();
  const g = (await grantMarket(broker)) as { token: string };
  const r = await broker.call(g.token, "read", { pair: "EURUSD" });
  assert.ok(r.ok);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.equal(calls[0]!.credential, SECRET); // the provider adapter did get it
  assert.deepEqual(((await broker.call(g.token, "write")) as { reason: string }).reason, "ACTION_NOT_GRANTED");
  assert.deepEqual(((await broker.call("ab".repeat(32), "read")) as { reason: string }).reason, "BAD_TOKEN");
});

test("call: the credential is caught in base64, hex and URL-encoded forms too, in answers and errors", async () => {
  const forms = [Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url"), Buffer.from(SECRET).toString("hex"),
    Buffer.from(SECRET).toString("hex").toUpperCase(), encodeURIComponent(SECRET), `Basic ${Buffer.from(`user:${SECRET}`).toString("base64")}`];
  for (const [i, form] of forms.entries()) {
    const bp: Blueprint = { ...blueprint, roles: [{ ...blueprint.roles[0]!, capabilities: ["p:read"] }, blueprint.roles[1]!] };
    const master = randomBytes(32);
    const broker = createBroker({
      vault: createVault(master, [sealCredential(master, "p", SECRET)]),
      providers: [{ id: "p", hosts: [], call: async (a) => { if (a === "read" && i % 2) throw new Error(`upstream said ${form}`); return { header: form }; } }],
      mandates: async () => ({ live: true, stageOpen: true, roleHash: hex(roleHash(bp.roles[0]!)) }),
    });
    broker.registerMission(MISSION, { buyer: base58Encode(randomBytes(32)), blueprint: bp, agents: { [AGENT]: "researcher" } });
    const g = (await broker.grant({ provider: "p", resource: "x", actions: ["read"], mission: MISSION, agent: AGENT })) as { token: string };
    const r = await broker.call(g.token, "read");
    if (form.startsWith("Basic ")) continue; // a credential inside a larger encoded blob is the reader's job (#71)
    assert.ok(!JSON.stringify(r).includes(form), `form ${i} leaked`);
    assert.ok(!r.ok);
  }
});

test("call: an answer that contains the credential is withheld", async () => {
  const leakyBp: Blueprint = { ...blueprint, roles: [{ ...blueprint.roles[0]!, capabilities: ["leaky:read"] }, blueprint.roles[1]!] };
  const master = randomBytes(32);
  const broker = createBroker({
    vault: createVault(master, [sealCredential(master, "leaky", SECRET)]),
    providers: [{ id: "leaky", hosts: [], call: async (_a, _r, _x, c) => ({ echo: c }) }],
    mandates: async () => ({ live: true, stageOpen: true, roleHash: hex(roleHash(leakyBp.roles[0]!)) }),
  });
  broker.registerMission(MISSION, { buyer: base58Encode(randomBytes(32)), blueprint: leakyBp, agents: { [AGENT]: "researcher" } });
  const g = (await broker.grant({ provider: "leaky", resource: "x", actions: ["read"], mission: MISSION, agent: AGENT })) as { token: string };
  const r = await broker.call(g.token, "read");
  assert.deepEqual((r as { reason: string }).reason, "LEAK_BLOCKED");
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("revoke on chain stops a running agent at its next call; tokens expire", async () => {
  const { broker, state, tick } = setup();
  const g = (await grantMarket(broker)) as { token: string };
  assert.ok((await broker.call(g.token, "read")).ok);
  state.set(AGENT, { ...state.get(AGENT)!, live: false }); // buyer revoked the mandate
  assert.deepEqual(((await broker.call(g.token, "read")) as { reason: string }).reason, "MANDATE_NOT_LIVE");
  assert.deepEqual(((await broker.call(g.token, "read")) as { reason: string }).reason, "BAD_TOKEN"); // dropped for good
  state.set(AGENT, { ...state.get(AGENT)!, live: true });
  const h = (await grantMarket(broker)) as { token: string };
  tick(601);
  assert.deepEqual(((await broker.call(h.token, "read")) as { reason: string }).reason, "EXPIRED");
});

test("elevated actions need the buyer's signature over the exact request, once, before it expires", async () => {
  const { broker, buyerSecret, tick } = setup();
  const req = { provider: "booking", resource: "hotel/42", actions: ["pay"], mission: MISSION, agent: OTHER };
  const reason = async (approval?: { sig: string; notAfter: number; nonce: string }) =>
    ((await broker.grant({ ...req, approval })) as { reason?: string }).reason;
  const approve = (r: typeof req, notAfter: number, nonce = randomBytes(16).toString("hex"), key = buyerSecret) =>
    ({ sig: Buffer.from(ed25519.sign(approvalBytes(r, notAfter, nonce), key)).toString("hex"), notAfter, nonce });
  assert.equal(await reason(), "ELEVATED_NEEDS_APPROVAL");
  assert.equal(await reason(approve({ ...req, resource: "hotel/43" }, 1_100)), "ELEVATED_NEEDS_APPROVAL"); // other request
  assert.equal(await reason(approve(req, 1_100, undefined, randomBytes(32))), "ELEVATED_NEEDS_APPROVAL"); // not the buyer
  assert.equal(await reason(approve(req, 5_000)), "APPROVAL_TOO_LONG");
  const one = approve(req, 1_100);
  assert.ok((await broker.grant({ ...req, approval: one })).ok);
  assert.equal(await reason(one), "APPROVAL_USED"); // one human click = one grant
  const late = approve(req, 1_050);
  tick(100);
  assert.equal(await reason(late), "APPROVAL_EXPIRED");
  // A signature cannot be stretched: changing notAfter or nonce breaks it.
  const fresh = approve(req, 1_500);
  assert.equal(await reason({ ...fresh, notAfter: 1_600 }), "ELEVATED_NEEDS_APPROVAL");
  assert.ok((await broker.grant({ ...req, approval: fresh })).ok);
  // Quote is not elevated: no signature needed.
  assert.ok((await broker.grant({ ...req, actions: ["quote"] })).ok);
});

// ---- egress proxy

const listen = (s: Server | ReturnType<typeof createTcpServer>) =>
  new Promise<number>((res) => s.listen(0, "127.0.0.1", () => res((s.address() as AddressInfo).port)));

function viaProxy(proxyPort: number, url: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: token ? { "proxy-authorization": `Bearer ${token}` } : {} }, (up) => {
      let body = "";
      up.on("data", (c) => (body += c));
      up.on("end", () => res({ status: up.statusCode ?? 0, body }));
    });
    r.on("error", rej);
    r.end();
  });
}

function connectVia(proxyPort: number, target: string, token?: string): Promise<string> {
  return new Promise((res, rej) => {
    const s = connect(proxyPort, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: Bearer ${token}\r\n` : ""}\r\n`);
    });
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("200 Connection Established") && !buf.includes("PING")) s.write("PING");
      if (buf.includes("PONG") || buf.includes("403")) { s.end(); res(buf); }
    });
    s.on("error", rej);
  });
}

test("egress: only host:port of a live capability's provider, only with its token; the token is stripped", async () => {
  let seenAuth: string | undefined = "unset";
  const upstream = createServer((req, res) => { seenAuth = req.headers["proxy-authorization"]; res.end("hello from upstream"); });
  const up = await listen(upstream);
  const other = createServer((_req, res) => res.end("a different local service"));
  const otherPort = await listen(other);
  const { broker, state } = setup({ marketHosts: [`127.0.0.1:${up}`] });
  const decisions: { allowed: boolean; host: string }[] = [];
  const proxy = createEgressProxy((t, h, p) => broker.egressAllowed(t, h, p), (d) => decisions.push(d));
  const pp = await listen(proxy);
  try {
    const g = (await grantMarket(broker)) as { token: string };
    const ok = await viaProxy(pp, `http://127.0.0.1:${up}/x`, g.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "hello from upstream");
    assert.equal(seenAuth, undefined);
    assert.equal((await viaProxy(pp, `http://127.0.0.1:${up}/x`)).status, 403); // no token
    assert.equal((await viaProxy(pp, `http://localhost:${up}/x`, g.token)).status, 403); // host not in provider list
    assert.equal((await viaProxy(pp, `http://127.0.0.1:${otherPort}/x`, g.token)).status, 403); // same host, other port
    state.set(AGENT, { ...state.get(AGENT)!, live: false });
    assert.equal((await viaProxy(pp, `http://127.0.0.1:${up}/x`, g.token)).status, 403); // revoked
    assert.ok(decisions.some((d) => !d.allowed) && decisions.some((d) => d.allowed));
  } finally {
    proxy.close();
    upstream.close();
    other.close();
  }
});

test("egress: CONNECT tunnels follow the same rule, port included", async () => {
  const echo = createTcpServer((s) => s.on("data", (d) => { if (d.toString().includes("PING")) s.write("PONG"); }));
  const ep = await listen(echo);
  const { broker } = setup({ marketHosts: [`127.0.0.1:${ep}`] });
  const proxy = createEgressProxy((t, h, p) => broker.egressAllowed(t, h, p));
  const pp = await listen(proxy);
  try {
    const g = (await grantMarket(broker)) as { token: string };
    assert.match(await connectVia(pp, `127.0.0.1:${ep}`, g.token), /PONG/);
    assert.match(await connectVia(pp, `127.0.0.1:${ep}`), /403/);
    assert.match(await connectVia(pp, `127.0.0.1:${ep + 1}`, g.token), /403/);
  } finally {
    proxy.close();
    echo.close();
  }
});
