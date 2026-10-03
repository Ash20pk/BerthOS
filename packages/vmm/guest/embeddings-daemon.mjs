// The guest's one embedding model, shared by the sandbox's apps
// (docs/design/microvm-semantic-fs.md, section 7). Loaded in every app, as in
// a container, it costs each about 200 MB, more than a microVM gives its apps
// together by default; here it is loaded once, on the first request.
//
// berth-init starts it confined under agent-init as berth-embeddings (uid
// 9004) when an app declares /context, from the embeddings kit it sits in
// (bundle-embeddings.mjs). Apps reach it through BERTH_EMBEDDINGS_SOCKET, a
// Unix socket only the berth group may connect to.
//
// Protocol: one JSON object per line each way.
//   {"id":"1","text":"..."}   ->  {"id":"1","embedding":[...384 floats]}
//                             or  {"id":"1","error":"..."}
//   {"id":"2","op":"warmup"}  ->  {"id":"2","ok":true} once the model is loaded
// Requests run one at a time, in order; text is cut to MAX_TEXT characters.
import { chmodSync, chownSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = dirname(fileURLToPath(import.meta.url));
const SOCKET = process.env.BERTH_EMBEDDINGS_SOCKET;
const SHARED_GID = Number(process.env.BERTH_SHARED_GID || 9999);
const MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_TEXT = 4096;
const MAX_LINE = 64 * 1024;
if (!SOCKET) {
  console.error("[embeddings] BERTH_EMBEDDINGS_SOCKET is not set");
  process.exit(2);
}

let pipelinePromise;
function model() {
  pipelinePromise ??= (async () => {
    const t = Date.now();
    const { pipeline, env } = await import(join(KIT, "transformers.mjs"));
    env.allowRemoteModels = false;
    env.cacheDir = join(KIT, "models");
    env.localModelPath = join(KIT, "models");
    env.backends.onnx.wasm.wasmPaths = `${KIT}/`;
    env.backends.onnx.wasm.numThreads = 1;
    const p = await pipeline("feature-extraction", MODEL, { quantized: true });
    console.error(`[embeddings] ${MODEL} loaded in ${Date.now() - t} ms`);
    return p;
  })().catch((err) => {
    pipelinePromise = undefined;
    throw err;
  });
  return pipelinePromise;
}

let queue = Promise.resolve();
function handle(req) {
  const run = async () => {
    const p = await model();
    if (req.op === "warmup") return { id: req.id, ok: true };
    if (typeof req.text !== "string") return { id: req.id, error: "text must be a string" };
    const out = await p(req.text.slice(0, MAX_TEXT), { pooling: "mean", normalize: true });
    return { id: req.id, embedding: Array.from(out.data) };
  };
  const result = queue.then(run, run).catch((err) => ({ id: req.id, error: String(err?.message ?? err).slice(0, 300) }));
  queue = result;
  return result;
}

rmSync(SOCKET, { force: true });
const server = net.createServer((conn) => {
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes("\n")) return conn.destroy();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        conn.write(`${JSON.stringify({ error: "not JSON" })}\n`);
        continue;
      }
      if (!req || typeof req !== "object") continue;
      void handle(req).then((res) => conn.writable && conn.write(`${JSON.stringify(res)}\n`));
    }
  });
  conn.on("error", () => {});
});
server.listen(SOCKET, () => {
  // Group berth, 0660: every app is in it, nothing else in the guest is.
  chownSync(SOCKET, process.getuid(), SHARED_GID);
  chmodSync(SOCKET, 0o660);
  console.error(`[embeddings] listening on ${SOCKET}; ${MODEL} loads on the first request`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
