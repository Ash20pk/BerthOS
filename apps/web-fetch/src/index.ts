import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { allowedPatterns, isAllowed, type HostPattern } from "./hosts.js";
import { pageFromHtml } from "./page.js";

// The egress proxy the sandbox starts for an app that declares
// network:host:*. It's the only port the kernel lets this app connect to,
// and it refuses any host berth.yml doesn't name. undici's own fetch with an
// explicit dispatcher, rather than the global fetch: Node's built-in fetch is
// a different undici, and mixing the two loses response headers.
function proxy(): Dispatcher | undefined {
  const url = process.env.BERTH_EGRESS_PROXY_URL;
  return url ? new ProxyAgent(url) : undefined;
}
const dispatcher = proxy();

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 100_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

interface Fetched {
  url: string;
  status: number;
  content_type: string;
  body: string;
  truncated: boolean;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" isn't an absolute URL (it needs http:// or https://)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https URLs are supported, not ${url.protocol}`);
  return url;
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/**
 * Names the egress proxy refuses under every pattern, `*` included. Only
 * literal addresses and the two well-known names can be recognised here; a
 * name that resolves to one is caught by the proxy itself (the 403 path).
 */
function isInternal(host: string): boolean {
  if (host === "localhost" || host === "host.docker.internal") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return host.startsWith("[");
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function refusal(url: URL, patterns: HostPattern[]): Error {
  if (isInternal(url.hostname)) {
    return new Error(
      `${url.hostname} is an internal address (loopback, a private range, link-local such as the cloud metadata address, or the Docker host): the sandbox never lets an app reach one, whatever berth.yml declares.`,
    );
  }
  const declared = patterns.map((p) => p.scope).join(", ") || "(none)";
  const port = portOf(url);
  const line = port === 80 || port === 443 ? `network:host:${url.hostname}` : `network:host:${url.hostname}:${port}`;
  return new Error(
    `${url.hostname}${url.port ? `:${url.port}` : ""} isn't one of the hosts web-fetch may reach (${declared}). ` +
      `To allow it, add \`- ${line}\` to capabilities: in web-fetch's berth.yml and restart the app.`,
  );
}

/** Headers from the optional WEB_FETCH_HEADERS secret, for this host only. */
function secretHeadersFor(host: string): Record<string, string> {
  const raw = process.env.WEB_FETCH_HEADERS;
  if (!raw) return {};
  try {
    const all = JSON.parse(raw) as Record<string, Record<string, string>>;
    return all[host] ?? {};
  } catch {
    throw new Error("WEB_FETCH_HEADERS isn't valid JSON: it should map a host to headers, like {\"api.example.com\": {\"Authorization\": \"Bearer ...\"}}");
  }
}

async function readCapped(res: Awaited<ReturnType<typeof fetch>>): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk as Uint8Array);
      if (size + buf.length > MAX_BYTES) {
        chunks.push(buf.subarray(0, MAX_BYTES - size));
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function isText(contentType: string): boolean {
  return contentType === "" || /^text\/|json|xml|javascript|x-www-form-urlencoded|yaml|csv/i.test(contentType);
}

/**
 * One request, following redirects by hand so every hop's host is checked
 * against berth.yml first: a redirect to an undeclared host is refused with
 * the same explanation as a direct request to it.
 *
 * `maxChars` caps the text body returned. read_page passes Infinity and caps
 * the page's text instead: most pages carry more than MAX_CHARS of script in
 * their <head> alone, and cutting the markup there left the parser inside a
 * <script> with no text at all.
 */
async function send(method: string, rawUrl: string, body: string | undefined, contentType: string | undefined, maxChars = MAX_CHARS): Promise<Fetched> {
  const patterns = await allowedPatterns();
  let url = parseUrl(rawUrl);
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  for (let hop = 0; ; hop++) {
    if (!isAllowed(patterns, url.hostname, portOf(url))) throw refusal(url, patterns);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: currentMethod,
        headers: {
          ...(currentBody !== undefined && contentType ? { "content-type": contentType } : {}),
          ...secretHeadersFor(url.hostname),
        },
        ...(currentBody !== undefined && currentMethod !== "GET" && currentMethod !== "HEAD" ? { body: currentBody } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
      if (/403|Forbidden/i.test(cause)) {
        throw new Error(`the sandbox's egress proxy refused ${url.hostname}: internal addresses (loopback, private ranges, the cloud metadata address) are never reachable, whatever berth.yml says (${cause})`);
      }
      throw new Error(`request to ${url.toString()} failed: ${cause}`);
    }

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects, stopping at ${url.toString()}`);
      await res.body?.cancel().catch(() => {});
      url = parseUrl(new URL(location, url).toString());
      // 303, and 301/302 after a POST, become a GET, as browsers do.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      continue;
    }

    const content_type = res.headers.get("content-type") ?? "";
    const { bytes, truncated: byteCapped } = await readCapped(res);
    if (!isText(content_type)) {
      return { url: url.toString(), status: res.status, content_type, body: `[${content_type} body, ${bytes.length} bytes${byteCapped ? "+" : ""}, not shown]`, truncated: byteCapped };
    }
    const text = bytes.toString("utf-8");
    const truncated = byteCapped || text.length > maxChars;
    return { url: url.toString(), status: res.status, content_type, body: text.length > maxChars ? text.slice(0, maxChars) : text, truncated };
  }
}

const fetchedShape = {
  url: z.string(),
  status: z.number(),
  content_type: z.string(),
  body: z.string(),
  truncated: z.boolean(),
};

export default defineApp((app) => {
  app.export({
    name: "get",
    input: z.object({ url: z.string() }),
    output: z.object(fetchedShape),
    handler: ({ url }) => send("GET", url, undefined, undefined),
  });

  app.export({
    name: "request",
    input: z.object({ method: z.string(), url: z.string(), body: z.string(), content_type: z.string() }),
    output: z.object(fetchedShape),
    handler: async ({ method, url, body, content_type }) => {
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(method)) throw new Error(`unsupported method ${method}`);
      return send(method, url, body === "" ? undefined : body, content_type || undefined);
    },
  });

  app.export({
    name: "read_page",
    input: z.object({ url: z.string() }),
    output: z.object({
      url: z.string(),
      status: z.number(),
      title: z.string(),
      text: z.string(),
      links: z.array(z.object({ text: z.string(), href: z.string() })),
      truncated: z.boolean(),
    }),
    handler: async ({ url }) => {
      const res = await send("GET", url, undefined, undefined, Infinity);
      if (!/html/i.test(res.content_type)) {
        return { url: res.url, status: res.status, title: "", text: res.body.slice(0, MAX_CHARS), links: [], truncated: res.truncated || res.body.length > MAX_CHARS };
      }
      const page = pageFromHtml(res.body, res.url);
      const truncated = res.truncated || page.text.length > MAX_CHARS;
      return { url: res.url, status: res.status, title: page.title, text: page.text.slice(0, MAX_CHARS), links: page.links, truncated };
    },
  });

  app.export({
    name: "allowed_hosts",
    output: z.object({ hosts: z.array(z.string()) }),
    handler: async () => ({ hosts: (await allowedPatterns()).map((p) => p.scope) }),
  });
});
