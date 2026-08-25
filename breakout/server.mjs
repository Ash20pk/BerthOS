// The break-out box's public endpoint.
//
// It accepts code from strangers and runs it inside the box. That is the
// entire product: an invitation to break a sandbox that is running exactly
// what Berth ships. Read breakout/README.md before deploying this anywhere —
// the host is expected to be disposable and to hold nothing else.
//
// What this server is NOT: a boundary. It is a thin relay between an HTTP
// request and the target app's `attempt` export. Every protection worth
// anything is inside the sandbox, which is the point of the exercise.
//
// Endpoints:
//   GET  /            the rules, as text
//   GET  /attestation the box's boot attestation (M2.1), regenerated per boot
//   GET  /log         the public attempt log — the audit trail, hash-chained
//   POST /attempt     {"code": "..."} → {"ok": bool, "output": "..."}

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileAuditSink, readAuditFile, verifyAuditChain } from "@berth/audit";
import { bootBox, mintFlags, detectCapture } from "./box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATE_DIR = join(__dirname, "state");
const AUDIT_PATH = join(STATE_DIR, "attempts.jsonl");
const ATTESTATION_PATH = join(STATE_DIR, "attestation.json");

const PORT = Number(process.env.BREAKOUT_PORT ?? 8099);
const BIND = process.env.BREAKOUT_BIND ?? "127.0.0.1";
const MAX_CODE_BYTES = Number(process.env.BREAKOUT_MAX_CODE_BYTES ?? 16 * 1024);
const ATTEMPT_TIMEOUT_MS = Number(process.env.BREAKOUT_ATTEMPT_TIMEOUT_MS ?? 30000);
/** Attempts run one at a time: submissions share one sandbox, and interleaving them would make the log ambiguous about which one did what. */
let inFlight = null;

function clientIp(req) {
  return req.socket.remoteAddress ?? "unknown";
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const rules = await readFile(join(__dirname, "rules.md"), "utf-8");

  const flags = mintFlags();
  // The flags live only in this process's memory and in the running box. They
  // are never written to the state directory, which is served publicly.
  console.log("Minted fresh flags for this boot. Capture claims are verified against these values.");

  const box = await bootBox({ repoRoot: REPO_ROOT, flags, log: (m) => console.log(`[box] ${m}`) });
  const enforcement = await box.enforcement();
  const enforcing = enforcement.doctorProbe?.status === "enforcing" && (enforcement.rulesetReports ?? []).every((r) => r.ruleset === "FullyEnforced");

  // Refusing to serve on a host that cannot enforce is the honest behaviour:
  // the kernel-tier flag would be readable by the first submission, and the
  // box would be advertising a boundary that is not there.
  if (!enforcing && process.env.BREAKOUT_ALLOW_UNENFORCED !== "1") {
    await box.stop();
    console.error(
      `REFUSING TO SERVE: this host does not enforce Landlock (probe=${enforcement.doctorProbe?.status}). ` +
        `The kernel-tier flag would not be protected. See docs/mac-enforcement.md, or set BREAKOUT_ALLOW_UNENFORCED=1 to run an unprotected box on purpose.`,
    );
    process.exit(1);
  }

  await writeAttestation(box, enforcement);

  // The public attempt log. Hash-chained by the same sink the rest of Berth
  // uses, so a challenger can check that entries were not removed after the
  // fact — subject to the same "the host could rewrite it all" caveat the
  // audit reference states.
  const audit = createFileAuditSink({ path: AUDIT_PATH, capturePayloads: true });

  const server = createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
      res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    };

    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/rules")) return send(200, rules, "text/markdown; charset=utf-8");
      if (req.method === "GET" && req.url === "/attestation") return send(200, await readFile(ATTESTATION_PATH, "utf-8"));
      if (req.method === "GET" && req.url === "/log") {
        const records = readAuditFile(AUDIT_PATH);
        const chain = verifyAuditChain(records);
        return send(200, { records: records.length, chainIntact: chain.valid, head: chain.endHash, entries: records });
      }
      if (req.method !== "POST" || req.url !== "/attempt") return send(404, { error: "see GET / for the rules" });

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_CODE_BYTES) return send(413, { error: `submissions are capped at ${MAX_CODE_BYTES} bytes` });
        chunks.push(chunk);
      }
      let code;
      try {
        code = JSON.parse(Buffer.concat(chunks).toString("utf-8")).code;
      } catch {
        return send(400, { error: 'send {"code": "…"} as JSON' });
      }
      if (typeof code !== "string" || code.length === 0) return send(400, { error: '"code" must be a non-empty string' });

      if (inFlight) return send(429, { error: "another attempt is running — submissions share one sandbox, so they run one at a time" });

      const codeSha256 = createHash("sha256").update(code).digest("hex");
      const started = Date.now();
      inFlight = box.attempt(code, ATTEMPT_TIMEOUT_MS);
      let result;
      try {
        result = await inFlight;
      } finally {
        inFlight = null;
      }

      const captured = detectCapture(result.output ?? "", flags);
      // The decision recorded is about the boundary, not about whether the
      // submission threw: an attempt that failed with EACCES is the box
      // working, and is logged as "denied" with the kernel's own message.
      await audit.record({
        ts: new Date().toISOString(),
        seq: 0,
        actor: { kind: "anonymous", id: clientIp(req), verifiedBy: "self-asserted" },
        action: "breakout.attempt",
        target: "breakout-target",
        decision: captured.length > 0 ? "allowed" : "denied",
        reason: captured.length > 0 ? `CAPTURED ${captured.join(", ")}` : "the sandbox refused this attempt",
        input: { code },
        output: { ok: result.ok, output: (result.output ?? "").slice(0, 4000) },
        durationMs: Date.now() - started,
        meta: { codeSha256, captured },
      });

      if (captured.length > 0) {
        console.error(`\n*** ${captured.join(" + ")} CAPTURED by ${clientIp(req)} — submission sha256 ${codeSha256} ***\n`);
      }

      return send(200, { ok: result.ok, output: result.output, captured });
    } catch (err) {
      return send(500, { error: `the box errored: ${err?.message ?? err}` });
    }
  });

  server.listen(PORT, BIND, () => {
    console.log(`\nBreak-out box listening on http://${BIND}:${PORT}`);
    console.log(`  rules:       GET  /`);
    console.log(`  attestation: GET  /attestation`);
    console.log(`  attempt log: GET  /log`);
    console.log(`  submit:      POST /attempt  {"code":"…"}`);
    if (!enforcing) console.warn("  WARNING: serving WITHOUT kernel enforcement — the kernel-tier flag is not protected.");
  });

  const shutdown = async () => {
    console.log("\nstopping the box");
    server.close();
    await box.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * The box's own boot attestation (BUILD_PLAN M2.1), published at
 * /attestation. This is the first place a Berth chain head leaves the writer's
 * reach: once challengers have fetched it, a later rewrite of the box's audit
 * trail is contradicted by the copies they hold.
 */
async function writeAttestation(box, enforcement) {
  const record = {
    kind: "berth.breakout-box-boot",
    generatedAt: new Date().toISOString(),
    trustModel:
      "tamper-evident, not tamper-proof: this record was produced by software on the attested host. It becomes evidence only once challengers hold copies the host cannot reach. Nothing here is key-signed.",
    box: { container: box.containerName, bootId: enforcement.bootId, imageDigest: enforcement.imageDigest },
    enforcement: { doctorProbe: enforcement.doctorProbe, rulesetReports: enforcement.rulesetReports },
    note: "Per-run attestations for individual attempts are available via `berth attest` against this box's audit trail — see docs/attestation-reference.md.",
  };
  await writeFile(ATTESTATION_PATH, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote the box's boot attestation to ${ATTESTATION_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
