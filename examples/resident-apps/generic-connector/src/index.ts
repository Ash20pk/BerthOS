import { defineConnectorApp } from "@berth/sdk";

// JSONPLACEHOLDER_BASE_URL lets index.test.ts point this at a real local
// server instead of the live internet — same override pattern
// apps/github-assistant's own GITHUB_API_BASE_URL uses, for the same reason:
// a config-driven connector's operations have no built-in "no creds → stub"
// escape hatch for a public, no-auth API, so something has to keep
// `berth test`'s automatic stub-invocation of every export (and this file's
// own unit test) from hitting the real internet.
const BASE_URL = process.env.JSONPLACEHOLDER_BASE_URL ?? "https://jsonplaceholder.typicode.com";

export default defineConnectorApp({
  baseUrl: BASE_URL,
  auth: { type: "none" },
  operations: [
    {
      export: "get_post",
      method: "GET",
      path: "/posts/{id}",
      params: { id: { in: "path", type: "number" } },
      description: "Fetch a single post by id",
    },
    {
      export: "create_post",
      method: "POST",
      path: "/posts",
      params: {
        title: { in: "body", type: "string" },
        body: { in: "body", type: "string" },
        userId: { in: "body", type: "number" },
      },
      description: "Create a new post",
    },
  ],
});
