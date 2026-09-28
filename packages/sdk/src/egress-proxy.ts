import { FormData, Headers, ProxyAgent, Request, Response, fetch, setGlobalDispatcher } from "undici";
import type { RequestInfo, RequestInit } from "undici";

/**
 * undici's fetch() only accepts its own Request class. A Request built from
 * Node's built-in class (one made before configureEgressProxy() ran, or by a
 * library that captured globalThis.Request early) is, to it, an arbitrary
 * object, and it fails with "Failed to parse URL from [object Request]". So
 * such a Request is rebuilt as an undici one, carrying over everything a
 * caller can set on it, before it is handed on.
 */
function toUndiciRequest(input: object): Request {
  const foreign = input as globalThis.Request;
  const init: RequestInit & { duplex?: "half" } = {
    method: foreign.method,
    headers: [...foreign.headers],
    signal: foreign.signal,
    redirect: foreign.redirect,
    integrity: foreign.integrity,
    keepalive: foreign.keepalive,
    cache: foreign.cache,
    credentials: foreign.credentials,
    referrer: foreign.referrer,
    referrerPolicy: foreign.referrerPolicy,
    mode: foreign.mode === "navigate" ? "same-origin" : foreign.mode,
  };
  if (foreign.body !== null) {
    init.body = foreign.body as RequestInit["body"];
    init.duplex = "half";
  }
  return new Request(foreign.url, init);
}

function isForeignRequest(input: unknown): input is object {
  if (typeof input !== "object" || input === null || input instanceof Request || input instanceof URL) return false;
  const candidate = input as { url?: unknown; method?: unknown; headers?: unknown };
  return typeof candidate.url === "string" && typeof candidate.method === "string" && typeof candidate.headers === "object";
}

function proxiedFetch(input: RequestInfo, init?: RequestInit): ReturnType<typeof fetch> {
  return fetch(isForeignRequest(input) ? toUndiciRequest(input) : input, init);
}

/**
 * The one line any resident app needing outbound network access wires in
 * itself — entrypoint.sh starts a real egress broker and exports
 * BERTH_EGRESS_PROXY_URL whenever this app's berth.yml declares
 * browser:navigate:<pattern> or network:host:<pattern> (see
 * packages/docker-orchestrator/docker/egress-broker.cjs); this just routes
 * this process's global fetch()/undici traffic through it. Neither
 * capability requires a bespoke broker of its own the way github:read/write
 * verb-scoping does (apps/github-assistant's own broker does real TLS
 * interception for that harder problem — see
 * docs/github-api-scoping-reference.md) — a plain host-match is enough for
 * the common "reach this one host" case, and every app gets the identical
 * mechanism for it, not just apps/browser-native's Chromium launch flag.
 *
 * A no-op when neither capability is declared (BERTH_EGRESS_PROXY_URL is
 * unset then), so calling this unconditionally at module load is always
 * safe — an app with no network:host:* or browser:navigate:* capability
 * just keeps making requests directly, exactly as if this were never called.
 */
export function configureEgressProxy(): void {
  const proxyUrl = process.env.BERTH_EGRESS_PROXY_URL;
  if (!proxyUrl) return;
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  // Node's built-in fetch() is a bundled copy of an older undici, and it reads
  // the same global dispatcher slot. Driving it with this package's ProxyAgent,
  // which negotiates HTTP/2, loses the headers of HTTP/2 responses across the
  // version gap: content-encoding disappears and a compressed body comes back
  // as raw bytes. So fetch() and its classes are replaced with the ones from
  // the undici that owns the dispatcher — the whole family, so a Request or
  // Headers built by the app is one fetch() accepts. A Request built from the
  // built-in class before this swap is still accepted: see toUndiciRequest().
  Object.assign(globalThis, { fetch: proxiedFetch, Headers, Request, Response, FormData });
}
