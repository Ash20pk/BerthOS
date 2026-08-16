import * as http from "node:http";
import * as https from "node:https";
import { timingSafeEqual } from "node:crypto";
import type { BerthApp } from "./app.js";
import { invokeExport, type RpcRequest } from "./rpc.js";

/**
 * The RPC bridge for a resident app deployed to a remote fleet (E2B, Daytona,
 * K8s) — see @berth/agents's bootNetworkedAgent({fleet}). None of those
 * providers expose anything like docker-orchestrator's invokeAppExport
 * (container.exec/attach), but they do give a real, publicly reachable HTTPS
 * URL for an exposed port (E2B's getHost, Daytona's getPreviewLink, or a
 * NodePort Service on K8s) — so this speaks HTTP instead of the line-JSON
 * framing the stdio/socket/TCP transports in rpc.ts use. Same {id, export,
 * input} -> {id, result}/{id, error} wire contract either way.
 *
 * Unlike the Unix-socket transport (only reachable via `docker exec`, i.e.
 * already gated by host access) or the TCP transport (only reachable inside
 * a shared Docker network), this listens on a real public URL — so a bearer
 * token generated per-boot and checked here is load-bearing, not optional.
 *
 * **TLS.** Pass `tls` to serve HTTPS directly (REMEDIATION.md 5.3). Whether
 * you need to depends on how the port is exposed: E2B's `getHost` and
 * Daytona's preview links terminate TLS in front of this, so the bearer
 * token is already protected in transit there and this listener is only
 * reachable through their proxy. A NodePort Service, a raw port mapping, or
 * anything else that hands out the port directly is the case that matters —
 * there the token crosses the network in the clear, and the alternative to
 * this option is a sidecar terminator the deploy adapters do not set up.
 */
export function startHttpRpcServer(
  app: BerthApp,
  options: { port: number; authToken: string; tls?: { cert: string; key: string } },
): http.Server {
  const expectedToken = Buffer.from(options.authToken, "utf-8");

  const handler: http.RequestListener = (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (!isAuthorized(req.headers.authorization, expectedToken)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid or missing bearer token" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      void handleRequest(app, body, res);
    });
  };

  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);

  server.listen(options.port, "0.0.0.0", () => {
    console.error(
      `[berth:runtime] ${options.tls ? "HTTPS" : "HTTP"} RPC server listening on 0.0.0.0:${options.port}` +
        (options.tls ? "" : " (plain HTTP — the bearer token is protected only by whatever terminates TLS in front of this)"),
    );
  });

  return server;
}

/**
 * Constant-time comparison against the expected token — a plain `===`/
 * string-includes check here would leak how many leading bytes matched via
 * response timing, the standard bearer-token-comparison pitfall.
 * `timingSafeEqual` requires equal-length buffers, so a length mismatch
 * (checked first) is itself not timing-sensitive: it's a public, constant
 * property of the request, not a secret being guessed byte-by-byte.
 */
function isAuthorized(header: string | undefined, expectedToken: Buffer): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf-8");
  if (provided.length !== expectedToken.length) return false;
  return timingSafeEqual(provided, expectedToken);
}

async function handleRequest(app: BerthApp, body: string, res: http.ServerResponse): Promise<void> {
  let request: RpcRequest;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  // "http" so a governor can distinguish the bridge from the root-only relay
  // socket — same reason the TCP listener names itself (REMEDIATION.md 1.13).
  const response = await invokeExport(app, request, "http");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
}
