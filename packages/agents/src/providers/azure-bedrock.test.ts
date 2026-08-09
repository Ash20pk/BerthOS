import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureOpenAIProvider } from "./azure-openai.js";
import { createBedrockProvider } from "./bedrock.js";
import { startMockLLMServer, openAICompletion } from "./mock-server.js";

/**
 * REMEDIATION 3.7. Azure and Bedrock share every line of message-mapping and
 * tool-calling logic with the OpenAI adapter (openai.test.ts covers that
 * once), so the only thing left that can be uniquely wrong in these two files
 * is how each constructs its client: the URL a request lands on and the
 * header it authenticates with. Those are asserted here against a real
 * request, because both are invisible from the call site.
 */

test("Azure routes by deployment in the path, with an api-version query param", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await createAzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: server.url,
      deployment: "my-deployment",
      apiVersion: "2024-10-21",
    }).chat({ messages: [{ role: "user", text: "hi" }], tools: [] });

    const request = server.onlyRequest();
    assert.match(request.path, /^\/openai\/deployments\/my-deployment\/chat\/completions/);
    assert.match(request.path, /api-version=2024-10-21/);
  } finally {
    await server.close();
  }
});

/**
 * Azure authenticates with an `api-key` header, not `Authorization: Bearer` —
 * the single most consequential difference between it and plain OpenAI, and
 * one that only shows up as a 401 against a real endpoint.
 */
test("Azure authenticates with an api-key header, not a bearer token", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await createAzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: server.url,
      deployment: "d",
    }).chat({ messages: [{ role: "user", text: "hi" }], tools: [] });

    const headers = server.onlyRequest().headers;
    assert.equal(headers["api-key"], "azure-key");
    assert.equal(headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test("Azure refuses to construct without a deployment rather than failing at call time", () => {
  const saved = process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  try {
    assert.throws(() => createAzureOpenAIProvider({ apiKey: "k", endpoint: "http://example.invalid" }), /deployment/);
  } finally {
    if (saved !== undefined) process.env.AZURE_OPENAI_DEPLOYMENT = saved;
  }
});

test("Bedrock sends a bearer token and reaches its OpenAI-compatible chat route", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await createBedrockProvider({ apiKey: "bedrock-token", baseURL: server.url, model: "anthropic.claude-sonnet-5" }).chat({
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    });

    const request = server.onlyRequest();
    assert.equal(request.headers.authorization, "Bearer bedrock-token");
    assert.match(request.path, /chat\/completions/);
    assert.equal(request.body.model, "anthropic.claude-sonnet-5");
  } finally {
    await server.close();
  }
});

/**
 * The point of the shared implementation: 3.1's fix was made once in
 * openai.ts and has to hold for every provider built on it. Asserted for both
 * rather than assumed from the import.
 */
test("both inherit the empty-tools fix from the shared implementation", async () => {
  for (const build of [
    (url: string) => createAzureOpenAIProvider({ apiKey: "k", endpoint: url, deployment: "d" }),
    (url: string) => createBedrockProvider({ apiKey: "k", baseURL: url }),
  ]) {
    const server = await startMockLLMServer();
    try {
      server.respondWith(openAICompletion());
      await build(server.url).chat({ messages: [{ role: "user", text: "hi" }], tools: [] });
      assert.equal("tools" in server.onlyRequest().body, false);
    } finally {
      await server.close();
    }
  }
});
