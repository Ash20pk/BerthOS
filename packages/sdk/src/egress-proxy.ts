import { FormData, Headers, ProxyAgent, Request, Response, fetch, setGlobalDispatcher } from "undici";

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
  // Headers built by the app is one fetch() accepts.
  Object.assign(globalThis, { fetch, Headers, Request, Response, FormData });
}
