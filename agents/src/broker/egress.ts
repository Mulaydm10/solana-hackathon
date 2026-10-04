/**
 * Egress proxy (PLAN §6.2, §7 "no data leaks out"). Every agent VM is started with HTTP_PROXY/HTTPS_PROXY
 * pointing here and no other route out. A connection is allowed only when the agent presents a live
 * capability token (Proxy-Authorization: Bearer <token>) whose provider lists the target host, and the
 * agent's mandate is still live on chain. Anything else gets 403 and is never opened, so an injected
 * instruction cannot send data to an attacker's server.
 * Handles CONNECT (HTTPS tunnels) and absolute-URI HTTP requests.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";

export type EgressCheck = (token: string, host: string) => Promise<boolean>;

export type EgressLog = { allowed: boolean; host: string; port: number; method: string };

function tokenOf(req: IncomingMessage): string {
  const h = req.headers["proxy-authorization"];
  const m = typeof h === "string" ? /^Bearer\s+([0-9a-f]{16,128})$/i.exec(h.trim()) : null;
  return m ? m[1]!.toLowerCase() : "";
}

/** `allowed` is usually `broker.egressAllowed`. `onDecision` sees every decision (for audit), never the token. */
export function createEgressProxy(allowed: EgressCheck, onDecision?: (d: EgressLog) => void): Server {
  const server = createServer(async (req, res) => {
    // Plain HTTP through a proxy uses an absolute URI.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute URI required");
      return;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const ok = url.protocol === "http:" && (await allowed(tokenOf(req), url.hostname.toLowerCase()).catch(() => false));
    onDecision?.({ allowed: ok, host: url.hostname, port, method: req.method ?? "" });
    if (!ok) {
      res.writeHead(403).end("egress refused");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"]; // the capability token never leaves the proxy
    delete headers["proxy-connection"];
    const upstream = httpRequest({ host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.headersSent ? res.end() : res.writeHead(502).end("upstream failed"));
    req.pipe(upstream);
  });

  server.on("connect", async (req, socket, head) => {
    const [host = "", portText = "443"] = (req.url ?? "").split(":");
    const port = Number(portText);
    const ok = Number.isInteger(port) && port > 0 && (await allowed(tokenOf(req), host.toLowerCase()).catch(() => false));
    onDecision?.({ allowed: ok, host, port, method: "CONNECT" });
    if (!ok) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
  });
  return server;
}
