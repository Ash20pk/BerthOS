#!/usr/bin/env node
// Real, running verification of the governance gate (docs/governance-reference.md):
// when a Computer loads an app declaring `governs: true`, every other app's
// tool calls get routed through that app's evaluate_action export first.
// This fixture denies write_file and allows everything else.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { Computer, GovernanceDeniedError } from "../dist/index.js";
import { invokeAppExport } from "@berth/docker-orchestrator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const GOVERNANCE_APP_DIR = join(__dirname, "fixtures", "governance-gate-tester");
const PEER_CALLER_APP_DIR = join(__dirname, "fixtures", "governance-peer-caller");

// The port apps/filesystem's TCP listener binds inside the container. Nothing
// publishes it to the host, and on an enforcing kernel nothing binds it
// either — see assertTcpListenerCannotBind.
const TCP_PORT = 7911;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/filesystem + the governance-gate-tester and governance-peer-caller fixtures...");
  // httpRpc so the bridge — one of the transports REMEDIATION.md 1.13 lists
  // as ungated — actually exists in this container to be tested.
  const computer = await Computer.boot({
    apps: [FILESYSTEM_APP_DIR, GOVERNANCE_APP_DIR, PEER_CALLER_APP_DIR],
    httpRpc: true,
    // App-scoped rather than the container-wide BERTH_NETWORK_PORT, so that
    // exactly one of the three apps opens a TCP listener instead of all three
    // racing for the same port (rpc.ts's envNetworkPort).
    env: { BERTH_NETWORK_PORT_FILESYSTEM: String(TCP_PORT) },
  });

  try {
    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("filesystem__write_file"), `expected "filesystem__write_file", got: ${JSON.stringify(toolNames)}`);
    assert(
      toolNames.includes("governance-gate-tester__evaluate_action"),
      `expected "governance-gate-tester__evaluate_action", got: ${JSON.stringify(toolNames)}`,
    );

    console.log("Calling filesystem__write_file, which the fixture's policy denies...");
    let deniedErr;
    try {
      await computer.call("filesystem__write_file", { path: "governance-gate-test.txt", content: "should never land" });
    } catch (err) {
      deniedErr = err;
    }
    assert(deniedErr instanceof GovernanceDeniedError, `expected a GovernanceDeniedError, got: ${deniedErr}`);
    assert(
      deniedErr.reason === "writes are blocked by this test fixture's policy",
      `expected the fixture's denial reason, got: ${deniedErr.reason}`,
    );
    console.log("Denied as expected:", deniedErr.message);

    console.log("Calling filesystem__list_files, which the fixture's policy allows...");
    const result = await computer.call("filesystem__list_files", {});
    console.log("list_files result:", result);
    assert(Array.isArray(result.files), `expected an allowed call to succeed normally, got: ${JSON.stringify(result)}`);

    console.log("\nPASS — the governance gate denies write_file and allows everything else, exactly per the fixture's policy.");

    await assertTransportsAreGated(computer);
  } finally {
    await computer.stop();
  }
}

/**
 * REMEDIATION.md 1.13's second half: the same denial, through the transports
 * that never touch a Computer. Before the SDK-dispatch gate, each of these
 * reached the app's export with no governor anywhere on the path — so an
 * agent denied `write_file` above could simply ask again over one of these
 * and be obeyed.
 *
 * One row per transport, each with its own allowed-call control, because a
 * transport that had simply stopped working would "pass" every denial
 * assertion here.
 */
async function assertTransportsAreGated(computer) {
  const container = new Docker().getContainer(computer.containerName);
  const denied = /governance denied write_file/;

  console.log("\n--- Transport: the relay (what `berth rpc` and `berth mcp` use) ---");
  const relayDenied = await invokeAppExport(container, "filesystem", {
    id: "gate-relay-1",
    export: "write_file",
    input: { path: "via-relay.txt", content: "should never land" },
  });
  console.log("relay response:", relayDenied);
  assert(
    denied.test(relayDenied.error ?? ""),
    `expected the relay call to be denied by governance, got: ${JSON.stringify(relayDenied)} — a response with no error means the write ran, ` +
      "i.e. the same action the Computer just denied succeeded over `berth rpc`",
  );

  const relayAllowed = await invokeAppExport(container, "filesystem", { id: "gate-relay-2", export: "list_files", input: {} });
  assert(!relayAllowed.error, `expected an allowed export to still work over the relay, got: ${JSON.stringify(relayAllowed)}`);
  console.log("PASS — `berth rpc`'s own transport is gated, and an allowed export still runs on it.");

  console.log("\n--- Transport: the HTTP RPC bridge ---");
  assert(computer.httpRpc, "expected httpRpc: true to expose a bridge on the handle");
  const httpDenied = await bridgeCall(computer.httpRpc, {
    id: "gate-http-1",
    export: "write_file",
    input: { path: "via-http.txt", content: "should never land" },
  });
  console.log("bridge response:", httpDenied);
  assert(
    denied.test(httpDenied.error ?? ""),
    `expected the HTTP bridge call to be denied by governance, got: ${JSON.stringify(httpDenied)} — a response with no error means the write ran`,
  );

  const httpAllowed = await bridgeCall(computer.httpRpc, { id: "gate-http-2", export: "list_files", input: {} });
  assert(!httpAllowed.error, `expected an allowed export to still work over the bridge, got: ${JSON.stringify(httpAllowed)}`);
  console.log("PASS — the HTTP RPC bridge is gated, and an allowed export still runs on it.");

  await assertPeerSocketIsGated(container);
  await assertTcpListenerCannotBind(container, computer);

  // The file is the last word on it: a denial that still wrote would be a
  // denial in the logs only.
  const listed = await invokeAppExport(container, "filesystem", { id: "gate-relay-3", export: "list_files", input: {} });
  const names = JSON.stringify(listed.result ?? {});
  assert(
    !names.includes("via-relay.txt") && !names.includes("via-http.txt") && !names.includes("via-peer.txt") && !names.includes("via-tcp.txt"),
    `a denied write still reached the filesystem: ${names}`,
  );
  console.log("PASS — none of the four refused writes exists on disk.");
}

/**
 * The sibling peer socket — claims.md's second UNPROVEN row.
 *
 * capability-enforcement K14 already proves the *identity* half: a request
 * arriving on `/run/berth/filesystem/peers/<caller>/rpc.sock` is attributed to
 * `<caller>` by the kernel, because entrypoint.sh made that directory mode
 * 2710 group-owned by the caller. What no milestone asserted until now is the
 * *verdict* half — that the gate then actually refuses the call. That gap
 * mattered more than it sounds: this is the one transport an app can reach
 * without root, so an unenforced sibling channel is the denied agent's own way
 * around the governor rather than the operator's.
 *
 * The connection is made from inside the container, which is the only place
 * that socket exists.
 */
async function assertPeerSocketIsGated(container) {
  console.log("\n--- Transport: a sibling app's peer socket (app:invoke:filesystem) ---");
  const socket = "/run/berth/filesystem/peers/governance-peer-caller/rpc.sock";

  const peerDenied = await socketCall(container, socket, {
    id: "gate-peer-1",
    export: "write_file",
    input: { path: "via-peer.txt", content: "should never land" },
  });
  console.log("peer-socket response:", peerDenied);
  assert(
    /governance denied write_file/.test(peerDenied.error ?? ""),
    `expected the sibling's call to be denied by governance, got: ${JSON.stringify(peerDenied)} — a response with no error means a sibling ` +
      "can perform the exact action the governor refused the agent, without root and without touching a Computer",
  );

  const peerAllowed = await socketCall(container, socket, { id: "gate-peer-2", export: "list_files", input: {} });
  assert(
    !peerAllowed.error,
    `expected an allowed export to still work over the peer socket, got: ${JSON.stringify(peerAllowed)} — without this control a socket that ` +
      "had simply stopped accepting connections would pass the denial assertion above",
  );
  console.log("PASS — the sibling peer socket is gated, and an allowed export still runs on it.");
}

/**
 * The cross-container TCP listener — claims.md's first UNPROVEN row, which
 * this run closes in the opposite direction to the one the row expected.
 *
 * The row asked whether the governance gate covers the TCP transport. On a
 * kernel that enforces, the question does not arise: **the listener cannot
 * bind.** Landlock's `AccessNet::from_all` denies `BindTcp` for any app with
 * network scoping active, and `computeBindPorts()` grants a bind exemption for
 * exactly two ports — the HTTP RPC bridge's and ttyd's. `BERTH_NETWORK_PORT`'s
 * is neither, so `listen(2)` returns EACCES before a single byte of the
 * transport exists.
 *
 * That is a better answer than "gated": a governor is a policy check that
 * could be misconfigured, and this is a closed door. It is also why the fix
 * that came with this test is the `error` handler in rpc.ts's startTcpServer —
 * before it, that EACCES was an unhandled `error` event, so on every enforcing
 * kernel this listener took the whole app process down with it.
 *
 * Nothing in the product sets `BERTH_NETWORK_PORT*`; `Crew.networked()` uses
 * the authenticated HTTP RPC bridge. If the listener is ever wired up for
 * real, its port has to be added to `computeBindPorts()` — and this assertion
 * will fail loudly at that moment, which is the point of asserting it.
 */
async function assertTcpListenerCannotBind(container, computer) {
  console.log("\n--- Transport: the cross-container TCP listener (BERTH_NETWORK_PORT_FILESYSTEM) ---");

  // 1. The effect: nothing is listening on that port inside the container.
  const tcpDial = await tcpCall(container, TCP_PORT, {
    id: "gate-tcp-1",
    export: "write_file",
    input: { path: "via-tcp.txt", content: "should never land" },
  });
  console.log("tcp response:", tcpDial);
  assert(
    /ECONNREFUSED/.test(tcpDial.error ?? ""),
    `expected nothing to be listening on ${TCP_PORT}, got: ${JSON.stringify(tcpDial)} — if this is a governance denial the listener DID bind, ` +
      "which means computeBindPorts() grew a port and this row now needs the gated-transport assertions instead",
  );

  // 2. The cause, distinguished from every other reason a port might be quiet.
  //    Without this the assertion above also passes when the env var never
  //    arrived, when the app crashed, or when the SDK ignored the variable —
  //    none of which are the kernel refusing a bind.
  const logs = demuxDockerStream(await container.logs({ stdout: true, stderr: true, tail: 5000 }));
  const refusal = logs.split("\n").find((l) => l.includes(`could not listen on 0.0.0.0:${TCP_PORT}`));
  assert(
    refusal,
    `expected the SDK to have tried to bind ${TCP_PORT} and logged the refusal. Not finding that line means the app never read ` +
      "BERTH_NETWORK_PORT_FILESYSTEM at all, so this test proved nothing about the listener.",
  );
  assert(
    /EACCES/.test(refusal),
    `expected the bind to fail with EACCES (Landlock's BindTcp denial), got: ${refusal.trim()} — another errno means the port is closed for some ` +
      "reason other than the kernel policy, and this row's claim would be wrong",
  );
  console.log("kernel refused the bind:", refusal.trim());

  // 3. The control: a bind that IS granted, in this same container, on this
  //    same kernel. The HTTP RPC bridge's port is in computeBindPorts, it
  //    bound, and the gated-transport assertions above went through it — so
  //    "bind fails here" is a statement about this port's policy, not about
  //    a container where binding never works.
  assert(computer.httpRpc, "expected the HTTP RPC bridge as the positive control for binding");
  console.log(`PASS — ${TCP_PORT} is refused by Landlock while the bridge's ${new URL(computer.httpRpc.url).port} bound in the same container.`);
}

/**
 * Sends one line-JSON request to a Unix socket or a TCP port *from inside the
 * container* and returns the parsed response.
 *
 * It has to run in there: the peer socket is a path that only exists in the
 * container's filesystem, and the TCP listener binds inside its network
 * namespace with no published port (publishing one would be a different test —
 * and a worse posture). Node is already on the image, so the payload is a
 * one-liner rather than another fixture.
 *
 * Runs as root, which is fine and is *not* what is under test here: the
 * caller's identity comes from which socket accepted the connection, not from
 * the connecting uid (rpc.ts's startPeerSocketServers explains why), so root
 * dialing the sibling's socket is attributed to the sibling exactly as the
 * sibling would be. K14 is the milestone that proves that attribution; this
 * one depends on it rather than repeating it.
 */
async function containerDial(container, target, request) {
  const script = `
const net = require("node:net");
const target = ${JSON.stringify(target)};
const socket = target.port ? net.connect(target.port, "127.0.0.1") : net.connect(target.path);
let buffer = "";
const fail = (why) => { console.log(JSON.stringify({ error: "dial failed: " + why })); process.exit(0); };
const timer = setTimeout(() => fail("timed out after 15s with no response line"), 15000);
socket.on("error", (err) => { clearTimeout(timer); fail(String(err)); });
socket.on("connect", () => socket.write(${JSON.stringify(JSON.stringify(request))} + "\\n"));
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const line = buffer.split("\\n")[0];
  if (!buffer.includes("\\n")) return;
  clearTimeout(timer);
  console.log(line);
  socket.end();
  process.exit(0);
});
`;
  const exec = await container.exec({
    Cmd: ["node", "-e", script],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const raw = demuxDockerStream(Buffer.concat(chunks));
  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no JSON response from inside the container. Raw exec output: ${JSON.stringify(raw)}`);
  return JSON.parse(line);
}

/**
 * Docker's non-TTY exec stream is a sequence of 8-byte-headed frames:
 * `[stream byte][3 reserved][4-byte big-endian payload length]`.
 *
 * Stripping "control characters" instead does not work and fails in a way that
 * looks like a product bug rather than a test bug: the fourth length byte is
 * frequently printable (a 110-byte payload puts an ASCII `n` right before the
 * JSON), so the line arrives as `n{"id":...}` and no longer parses.
 */
function demuxDockerStream(buffer) {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    out += buffer.subarray(offset + 8, offset + 8 + length).toString("utf-8");
    offset += 8 + length;
  }
  // A daemon that ever hands back an unframed stream should degrade to
  // readable output rather than to silence.
  return offset === 0 ? buffer.toString("utf-8") : out;
}

const socketCall = (container, path, request) => containerDial(container, { path }, request);
const tcpCall = (container, port, request) => containerDial(container, { port }, request);

async function bridgeCall(httpRpc, request) {
  // The handle carries the bridge's origin; the bridge itself serves POST
  // /rpc (http-rpc.ts:30) and 404s anything else.
  const res = await fetch(`${httpRpc.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${httpRpc.authToken}` },
    body: JSON.stringify(request),
  });
  return res.json();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nGOVERNANCE GATE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
