#!/usr/bin/env node
// Real, running verification of REMEDIATION 1.7: the ports `berth dev`
// publishes to the host are bound to loopback and gated by a credential,
// rather than being an unauthenticated writable root shell on every
// interface the host has.
//
// Boots a real apps/terminal dev container (it declares terminal:attach:*,
// which is what makes container.ts publish ttyd's port at all), then:
//
//   1. asks Docker itself what it bound, via inspect — the only source of
//      truth for HostIp, since a port that *looks* right in a log line can
//      still be on 0.0.0.0;
//   2. makes real unauthenticated HTTP requests to ttyd and asserts a 401;
//   3. makes the same request with the generated credential and asserts it
//      gets through — a 401-on-everything would pass test 2 while breaking
//      the feature;
//   4. asserts no CDP port is published at all.
//
// Runs anywhere Docker does — none of this depends on the host kernel being
// able to enforce Landlock, unlike capability-enforcement.mjs.
import Docker from "dockerode";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, createStdioRpcClient } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const TERMINAL_APP_DIR = join(REPO_ROOT, "apps", "terminal");
const BROWSER_APP_DIR = join(REPO_ROOT, "apps", "browser-native");

const docker = new Docker();
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

async function main() {
  const manifest = await loadManifest(join(TERMINAL_APP_DIR, "berth.yml"));

  console.log("Building terminal's dev image...");
  await buildImage({ appDir: TERMINAL_APP_DIR, tag: "berth/terminal:dev", target: "dev", docker });

  console.log("Starting terminal's sandbox...");
  const running = await startContainer({
    image: "berth/terminal:dev",
    name: "berth-test-published-port-security",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/terminal",
    docker,
  });

  try {
    const { ports, credentials } = running;
    console.log("\n--- Test 1: Docker bound the terminal port to loopback, not 0.0.0.0 ---");
    const inspect = await running.container.inspect();
    const mapped = inspect.NetworkSettings.Ports;
    const terminalBinding = mapped["7681/tcp"]?.[0];
    console.log("  7681/tcp ->", JSON.stringify(terminalBinding));
    check("ttyd's port is published", !!terminalBinding, "no host binding at all");
    check(
      "ttyd's port is bound to 127.0.0.1",
      terminalBinding?.HostIp === "127.0.0.1",
      `HostIp is ${JSON.stringify(terminalBinding?.HostIp)} — anything other than a loopback address puts a writable root shell on the LAN`,
    );

    console.log("\n--- Test 2: no CDP port is published to the host ---");
    // Not conditional on this app: BROWSER_PORTS no longer contains 9222 at
    // all, so no manifest can cause it to be published.
    check("9222/tcp has no host binding", !mapped["9222/tcp"], `bound to ${JSON.stringify(mapped["9222/tcp"])}`);

    console.log("\n--- Test 3: a credential was generated and handed to the container ---");
    check("startContainer returned a terminal credential", !!credentials.terminal, "none returned");
    const containerEnv = inspect.Config.Env ?? [];
    check(
      "the container received BERTH_TERMINAL_CREDENTIAL",
      containerEnv.some((e) => e === `BERTH_TERMINAL_CREDENTIAL=${credentials.terminal}`),
      "not present in the container's env",
    );

    // ttyd is started lazily by apps/terminal's ensureSession(), on the first
    // export call rather than at boot — so drive one, or there'd be nothing
    // listening to authenticate against.
    console.log("\nInvoking read_screen to make apps/terminal start ttyd...");
    const rpc = await createStdioRpcClient(running.container, docker);
    try {
      await rpc.call({ id: "1", export: "read_screen", input: {} });
    } finally {
      rpc.close();
    }

    const url = `http://127.0.0.1:${ports.terminal}/`;
    // The container's own log is where a Landlock denial shows up, and this
    // step is exactly where one lands: ttyd binds a port, and an app that
    // declares no network capability has BindTcp denied along with
    // ConnectTcp unless the policy grants it (see computeBindPorts). Dumping
    // it here rather than failing bare is the difference between diagnosing
    // that from one CI run and diagnosing it from three.
    await waitFor(async () => (await probe(url)).status !== 0, 30000, "ttyd listening", () =>
      dumpLogs(running.container, "terminal"),
    );

    console.log("\n--- Test 4: an unauthenticated request is refused ---");
    const anonymous = await probe(url);
    console.log(`  GET ${url} -> ${anonymous.status}`);
    check(
      "ttyd refuses an unauthenticated request",
      anonymous.status === 401,
      `got ${anonymous.status}; before this fix ttyd ran with no --credential at all and served a writable root shell to anyone who asked`,
    );

    console.log("\n--- Test 5: a wrong credential is refused ---");
    const wrong = await probe(url, "berth:definitely-not-the-password");
    console.log(`  GET ${url} (wrong credential) -> ${wrong.status}`);
    check("ttyd refuses a wrong credential", wrong.status === 401, `got ${wrong.status}`);

    console.log("\n--- Test 6: the generated credential does get through ---");
    const authed = await probe(url, credentials.terminal);
    console.log(`  GET ${url} (correct credential) -> ${authed.status}`);
    check(
      "ttyd accepts the generated credential",
      authed.status === 200,
      `got ${authed.status} — tests 4/5 would also pass if ttyd were simply broken, so this is the one that proves the terminal still works`,
    );
  } finally {
    await stopContainer(running.container).catch(() => {});
  }

  await checkVnc();

  console.log("");
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("All published-port security checks passed.");
}

/**
 * The VNC half, in its own container because it needs a browser:* app and,
 * critically, needs BERTH_TEST_MODE *unset* — every other browser milestone
 * test runs headless, which skips entrypoint.sh's display stack entirely and
 * would leave this change unverified.
 *
 * Asserts at the RFB protocol level rather than by scraping a log line: what
 * matters is which security type the server offers a client, since that is
 * what an attacker on the port actually sees. x11vnc's old `-nopw` offers
 * type 1 (None) — connect and you're in, with keyboard and mouse.
 */
async function checkVnc() {
  const manifest = await loadManifest(join(BROWSER_APP_DIR, "berth.yml"));

  console.log("\nBuilding browser-native's dev image...");
  await buildImage({ appDir: BROWSER_APP_DIR, tag: "berth/browser-native:dev", target: "dev", docker });

  console.log("Starting browser-native's sandbox (NOT in test mode, so the display stack really starts)...");
  const running = await startContainer({
    image: "berth/browser-native:dev",
    name: "berth-test-published-port-security-vnc",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/browser-native",
    docker,
  });

  try {
    const inspect = await running.container.inspect();
    const mapped = inspect.NetworkSettings.Ports;

    console.log("\n--- Test 7: the VNC and noVNC ports are bound to loopback ---");
    for (const [label, port] of [
      ["VNC", "5900"],
      ["noVNC", "6080"],
    ]) {
      const binding = mapped[`${port}/tcp`]?.[0];
      console.log(`  ${label} ${port}/tcp ->`, JSON.stringify(binding));
      check(`${label} is bound to 127.0.0.1`, binding?.HostIp === "127.0.0.1", `HostIp is ${JSON.stringify(binding?.HostIp)}`);
    }

    console.log("\n--- Test 8: a VNC password was generated and handed to the container ---");
    check("startContainer returned a VNC password", !!running.credentials.vnc, "none returned");
    check(
      "the password is 8 characters",
      running.credentials.vnc?.length === 8,
      `got ${running.credentials.vnc?.length} — VNC auth truncates to 8, so a longer one would overstate its strength`,
    );

    console.log("\n--- Test 9: the VNC server offers VNC Authentication, not None ---");
    const port = Number(mapped["5900/tcp"][0].HostPort);
    await waitFor(async () => (await rfbSecurityTypes(port)) !== undefined, 60000, "x11vnc listening", () =>
      dumpLogs(running.container, "browser-native"),
    );
    const types = await rfbSecurityTypes(port);
    console.log("  RFB security types offered:", types);
    check(
      "the server does not offer security type 1 (None)",
      !types?.includes(1),
      "type 1 means any client that connects gets keyboard and mouse control of the agent's display, no password asked — this is exactly what -nopw did",
    );
    check("the server offers security type 2 (VNC Authentication)", !!types?.includes(2), `offered ${JSON.stringify(types)}`);
  } finally {
    await stopContainer(running.container).catch(() => {});
  }
}

/**
 * Speaks just enough RFB to learn which security types the server offers:
 * read the server's "RFB 003.00N\n" banner, echo it back, then read the
 * security-type list. Returns undefined if nothing is listening yet.
 */
async function rfbSecurityTypes(port) {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let sentVersion = false;
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5000, () => done(undefined));
    socket.on("error", () => done(undefined));
    // Docker's proxy accepts the TCP connection whether or not anything is
    // listening inside the container, then closes it — without this the
    // promise never settles, nothing is left on the event loop, and Node
    // exits 0 in the middle of the test rather than failing it.
    socket.on("close", () => done(undefined));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!sentVersion) {
        if (buffer.length < 12) return;
        socket.write(buffer.subarray(0, 12)); // echo the server's own version back
        sentVersion = true;
        buffer = buffer.subarray(12);
      }
      // RFB 3.7+: one count byte, then that many security-type bytes.
      if (buffer.length < 1) return;
      const count = buffer[0];
      if (count === 0) return done([]); // a connection failure, not a type list
      if (buffer.length < 1 + count) return;
      done([...buffer.subarray(1, 1 + count)]);
    });
  });
}

/** Returns {status} — status 0 means the connection itself failed (nothing listening yet). */
async function probe(url, credential) {
  const headers = credential ? { Authorization: `Basic ${Buffer.from(credential).toString("base64")}` } : {};
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    return { status: res.status };
  } catch {
    return { status: 0 };
  }
}

async function waitFor(predicate, timeoutMs, label, onTimeout) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (onTimeout) await onTimeout();
  throw new Error(`timed out waiting for ${label}`);
}

/** Prints the container's log tail, so a timeout says why rather than just that. */
async function dumpLogs(container, label) {
  try {
    const buf = await container.logs({ stdout: true, stderr: true, tail: 60 });
    console.log(`\n--- ${label} container log (last 60 lines) ---`);
    console.log(buf.toString("utf-8").replace(/[\u0000-\u0008]/g, ""));
    console.log(`--- end ${label} log ---\n`);
  } catch (err) {
    console.log(`(could not read ${label} logs: ${err})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
