import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { ProxyAgent, setGlobalDispatcher, fetch } from "undici";

// Same routing as apps/github-assistant: everything through the GitHub API proxy on 8092.
if (process.env.BERTH_GITHUB_API_PROXY) setGlobalDispatcher(new ProxyAgent(process.env.BERTH_GITHUB_API_PROXY));

export default defineApp((app) => {
  app.export({
    name: "github_request",
    input: z.object({ method: z.string(), path: z.string(), body: z.string() }),
    output: z.object({ status: z.number(), body: z.string() }),
    handler: async ({ method, path, body }) => {
      const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      });
      return { status: res.status, body: (await res.text()).slice(0, 2000) };
    },
  });
  // Whether the token is in this process's environment (it's read from a
  // per-app file by the runtime before the app loads, so process.env has it;
  // what matters is that /proc/<pid>/environ, the container env, doesn't).
  app.export({
    name: "token_in_env",
    output: z.object({ present: z.boolean() }),
    handler: async () => ({ present: Boolean(process.env.GITHUB_TOKEN) }),
  });
});
