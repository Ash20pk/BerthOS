import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Test-only support for the provider adapters in this directory. Not exported
 * from index.ts — an internal helper, the same "not public API" posture
 * createOpenAICompatibleProvider() already has.
 *
 * Why a real HTTP server rather than stubbing each vendor SDK's client: the
 * bugs these adapters actually shipped (REMEDIATION 3.1, 3.2, 3.6) are all
 * about the *request body* an adapter builds or the *response field* it fails
 * to read. A stub of `client.chat.completions.create` asserts the arguments
 * this repo passes to the SDK, which is the half that was never wrong. Only a
 * real server sees what the SDK actually serializes and sends, which is what
 * the vendor's API would have rejected. Every provider here takes a baseURL
 * precisely so it can be pointed somewhere else, so this needs no injection
 * seam that production doesn't already have.
 */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body. Undefined if the request had no body or it wasn't JSON. */
  body: any;
  /** Raw body bytes, for asserting on serialization rather than on the parse. */
  raw: string;
}

export interface MockLLMServer {
  /** Base URL to hand the provider under test, e.g. `createOpenAIProvider({ baseURL: server.url })`. */
  url: string;
  /** Every request the provider actually sent, in order. */
  requests: CapturedRequest[];
  /** The single request a one-call test made — throws if there wasn't exactly one, so a silent retry can't be read as a pass. */
  onlyRequest(): CapturedRequest;
  /** Queue one response for the next request. Responses are consumed in order. */
  respondWith(body: unknown, status?: number): void;
  /**
   * Queue a Server-Sent Events response, for the streaming paths. Each item
   * becomes one `data:` frame; the terminating `[DONE]` frame OpenAI's client
   * expects is appended automatically.
   */
  respondWithStream(events: unknown[], options?: { done?: boolean }): void;
  close(): Promise<void>;
}

interface QueuedResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * Starts a throwaway HTTP server on an ephemeral port. Every provider test in
 * this directory takes one, points its adapter at it, and asserts on what
 * arrived — so a test can never pass by reaching a real vendor API, and needs
 * no API key to run in CI.
 */
export async function startMockLLMServer(): Promise<MockLLMServer> {
  const requests: CapturedRequest[] = [];
  const queue: QueuedResponse[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, raw });

      const queued = queue.shift();
      if (!queued) {
        // A test that queued fewer responses than the provider made requests
        // is a test whose assumptions are wrong — say so in the response body
        // so it surfaces as a readable failure rather than a hang or a parse
        // error deep inside a vendor SDK.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock server got an unexpected request to ${req.url} with no queued response` } }));
        return;
      }
      res.writeHead(queued.status, { "content-type": queued.contentType });
      res.end(queued.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    onlyRequest() {
      if (requests.length !== 1) {
        throw new Error(`expected exactly 1 request, got ${requests.length}: ${requests.map((r) => r.path).join(", ")}`);
      }
      return requests[0]!;
    },
    respondWith(body, status = 200) {
      queue.push({ status, body: JSON.stringify(body), contentType: "application/json" });
    },
    respondWithStream(events, options = {}) {
      const frames = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
      if (options.done !== false) frames.push("data: [DONE]\n\n");
      queue.push({ status: 200, body: frames.join(""), contentType: "text/event-stream" });
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/** A minimal well-formed OpenAI chat completion, for tests that only care about the request. */
export function openAICompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ...overrides,
  };
}

/** A minimal well-formed Anthropic message response. */
export function anthropicMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  };
}
