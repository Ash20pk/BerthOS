import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const GITHUB_API = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";

// entrypoint.sh sets BERTH_GITHUB_API_PROXY whenever berth.yml declares a
// github:* capability — but only actually route through it when this app is
// really about to hit the real api.github.com. GITHUB_API_BASE_URL (used by
// github-assistant-milestone.mjs's plain-HTTP mock, testing the app's own
// request-shaping logic in isolation from the broker) points at a plain-HTTP
// mock the broker's CONNECT-only listener would otherwise 400 — this guard
// keeps that scenario broker-free rather than special-casing plain HTTP in
// the broker itself. github-api-broker.cjs terminates TLS itself to enforce
// github:read:<scope> vs github:write:<scope>, so real traffic must be
// routed through it as an HTTP(S) proxy (undici doesn't consult
// HTTPS_PROXY/etc on its own). NODE_EXTRA_CA_CERTS (also set by
// entrypoint.sh) is what makes this app's TLS client actually trust the
// broker's generated leaf cert for api.github.com — that part needs no code,
// Node's TLS stack reads it automatically at process start.
if (process.env.BERTH_GITHUB_API_PROXY && !process.env.GITHUB_API_BASE_URL) {
  setGlobalDispatcher(new ProxyAgent(process.env.BERTH_GITHUB_API_PROXY));
}

/** Returns null if no live credentials are configured, so exports still work (with stub data) in `berth test` and local dev without a token. */
async function githubFetch(path: string, init?: RequestInit): Promise<any | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export default defineApp((app) => {
  app.export({
    name: "create_issue",
    input: z.object({ title: z.string(), body: z.string() }),
    handler: async ({ title, body }) => {
      const repo = process.env.GITHUB_REPO;
      if (!repo) return; // no repo configured — no-op, matches this export's PRD-defined input shape (repo isn't part of it)
      await githubFetch(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
    },
  });

  app.export({
    name: "get_repo_summary",
    input: z.object({ repo: z.string() }),
    output: z.object({ summary: z.string(), open_issues: z.number() }),
    handler: async ({ repo }) => {
      const data = await githubFetch(`/repos/${repo}`);
      if (!data) {
        return { summary: `${repo} (stub — set GITHUB_TOKEN for live data)`, open_issues: 0 };
      }
      return { summary: data.description ?? repo, open_issues: data.open_issues_count ?? 0 };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "github-assistant" });
  });
});
