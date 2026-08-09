#!/usr/bin/env node
// Real, running verification of Phase 3's kernel enforcement: confirms
// writes inside a resident app's declared filesystem:write path succeed,
// and a write outside it (via path traversal — proving the kernel catches
// what app code doesn't validate itself) is refused BY THE KERNEL. Also
// covers read-path scoping (opt-in — see generate-capability-policy.ts):
// apps/filesystem/berth.yml already declares filesystem:read:/workspace and
// filesystem:read:/context, so reads are confined to baseline+declared paths
// for this app without any test-only manifest changes.
//
// Note on scope: this only exercises the app's own runtime process, which is
// what agent-init actually restricts via landlock_restrict_self() before
// exec-ing into it. A separate `docker exec` into the same container would
// NOT be a descendant of that restricted process (Landlock only binds a
// process and its future fork/exec children) — so testing enforcement via
// `docker exec` wouldn't prove anything either way, and isn't attempted here.
//
// Environment caveat: Landlock enforcement requires the kernel to have
// "landlock" active in its LSM stack (check `cat /sys/kernel/security/lsm`
// after `mount -t securityfs securityfs /sys/kernel/security` in a
// privileged container). Docker Desktop for Mac's linuxkit VM kernel has the
// landlock syscalls present but does NOT list landlock as an active LSM
// (only `capability,bpf`) — agent-init's own restrict_self() call reports
// this via a `ruleset=NotEnforced` log line, and this script surfaces that
// as a clear warning rather than a false test failure. On a real Linux host
// or CI runner with Landlock active (most modern distros, GitHub Actions
// ubuntu-latest, real cloud VMs), this test should hard-fail if enforcement
// regresses — see docs/capability-tokens-reference.md.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const BOUNDARY_APP_A_DIR = join(__dirname, "fixtures", "boundary-app-a");
const BOUNDARY_APP_B_DIR = join(__dirname, "fixtures", "boundary-app-b");
// The authorized counterpart to app A: same source, but its berth.yml declares
// app:invoke:boundary-app-b (REMEDIATION.md 1.4).
const BOUNDARY_APP_C_DIR = join(__dirname, "fixtures", "boundary-app-c");

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  console.log("Starting filesystem's sandbox...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-capability-enforcement-filesystem",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    docker,
  });

  const containerLog = await startLogCapture(running.container);

  // Declared here (not `const` inside the try block below) so Test 6, which
  // needs to know whether this host can enforce anything at all, can read it
  // after that try/finally has already torn down the Test 1-7 container.
  let landlockActive;

  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
    await waitFor(() => /ruleset=/.test(containerLog.text()), 5000, "agent-init's landlock status line");

    const statusLine = containerLog.text().match(/\[agent-init\] landlock restrict_self\(\).*$/m)?.[0] ?? "";
    console.log(statusLine);
    landlockActive = /ruleset=FullyEnforced|ruleset=PartiallyEnforced/.test(statusLine);
    if (!landlockActive) {
      assert(
        !process.env.CI,
        "Landlock is NOT active in this CI runner's LSM stack. GitHub Actions ubuntu-latest is expected to " +
          "have Landlock active (mainline since kernel 5.13) — this is a real regression (runner image change, " +
          "kernel config change, or a container/security-opt change suppressing it), not an environment " +
          "limitation. Investigate before assuming Phase 3 enforces anything.",
      );
      console.log(
        "\nWARNING: this kernel does not have Landlock active in its LSM stack (see this file's header comment).\n" +
          "Enforcement cannot be verified in this environment — treating the write-outside-workspace check as\n" +
          "informational only, not a hard failure. Re-run this on a Landlock-enabled Linux host before trusting\n" +
          "that Phase 3 actually enforces anything in production.",
      );
    }

    const rpc = await createRpcClient(running.container);

    console.log("\n--- Test 1: write INSIDE the declared path (should always succeed) ---");
    const allowed = await rpc.call({
      id: "1",
      export: "write_file",
      input: { path: "allowed.txt", content: "this should work" },
    });
    console.log("response:", allowed);
    assert(!allowed.error, `expected write inside /workspace to succeed, got error: ${allowed.error}`);

    console.log("\n--- Test 2: write OUTSIDE the declared path via path traversal ---");
    const traversal = await rpc.call({
      id: "2",
      export: "write_file",
      input: { path: "../../../etc/berth-should-not-exist.txt", content: "if you can read this, enforcement failed" },
    });
    console.log("response:", traversal);

    const wasDenied = traversal.error && /EACCES|EPERM|permission/i.test(traversal.error);
    if (landlockActive) {
      assert(wasDenied, `Landlock is active but the traversal write was NOT denied — real regression: ${JSON.stringify(traversal)}`);
      console.log("\nPASS — write inside /workspace succeeded; write outside it was refused by the kernel.");
    } else {
      console.log(
        wasDenied
          ? "\n(Interesting: denied anyway, despite ruleset != Enforced — logged for information, not asserted.)"
          : "\nNOT VERIFIED (expected in this environment) — the traversal write succeeded because Landlock isn't enforced here.",
      );
    }

    console.log("\n--- Test 3: read INSIDE the declared+baseline path (should always succeed) ---");
    // apps/filesystem/berth.yml already declares filesystem:read:/workspace
    // and filesystem:read:/context — read scoping (opt-in per
    // generate-capability-policy.ts) is therefore already active for this
    // app, no synthetic manifest needed to exercise it.
    const insideRead = await rpc.call({ id: "3", export: "read_file", input: { path: "allowed.txt" } });
    assert(!insideRead.error, `expected read inside /workspace to succeed, got error: ${insideRead.error}`);

    console.log("\n--- Test 4: read OUTSIDE the declared+baseline paths via path traversal ---");
    // The fixture must actually exist for this to mean anything: Landlock
    // only gates open()/readdir() on a *resolved* inode, not path traversal
    // itself, so reading a path that simply doesn't exist returns ENOENT
    // from ordinary VFS lookup before Landlock's check is ever reached —
    // indistinguishable from "denied" by the error-message check below, but
    // proving nothing about enforcement either way. Created via a fresh
    // `docker exec` (unrestricted — a sibling of the Landlock-restricted app
    // process, not a descendant of it, same as this file's header comment
    // already notes about not *testing* enforcement via exec) rather than
    // baking a test-only file into entrypoint.sh's real production boot path.
    await execInContainer(running.container, ["sh", "-c", "mkdir -p /opt && echo secret > /opt/berth-should-not-be-readable.txt"]);
    const outsideRead = await rpc.call({
      id: "4",
      export: "read_file",
      input: { path: "../../../opt/berth-should-not-be-readable.txt" },
    });
    console.log("response:", outsideRead);
    const readDenied = outsideRead.error && /EACCES|EPERM|permission/i.test(outsideRead.error);
    if (landlockActive) {
      assert(readDenied, `Landlock is active but the out-of-scope read was NOT denied — real regression: ${JSON.stringify(outsideRead)}`);
      console.log("\nPASS — declaring filesystem:read:* confined reads to baseline+declared paths.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    console.log("\n--- Test 5: network is deny-by-default — filesystem declares no network:connect capability ---");
    // apps/filesystem/berth.yml declares no network:* capability, so under
    // the deny-by-default policy (packages/agent-init/src/main.rs) it should
    // get a Landlock ruleset with zero allowed outbound ports — a real
    // attempted TCP connect from inside the actually-restricted runtime
    // process (not a docker-exec'd one, see this file's header comment)
    // should fail at the kernel level, not just look denied.
    const netProbe = await rpc.call({
      id: "5",
      export: "probe_network_connect",
      input: { host: "1.1.1.1", port: 80 },
    });
    console.log("response:", netProbe);
    assert(!netProbe.error, `probe_network_connect itself errored (unexpected): ${netProbe.error}`);
    const wasNetDenied = netProbe.result?.connected === false;
    if (landlockActive) {
      assert(
        wasNetDenied,
        `Landlock is active but an app with no declared network:connect capability was able to connect out — deny-by-default regression: ${JSON.stringify(netProbe)}`,
      );
      console.log("\nPASS — an app declaring no network:connect capability could not reach out at all.");
    } else {
      console.log(
        wasNetDenied
          ? "\n(Interesting: denied anyway, despite ruleset != Enforced — logged for information, not asserted.)"
          : "\nNOT VERIFIED (expected in this environment) — the connect succeeded because Landlock isn't enforced here.",
      );
    }

    console.log("\n--- Test 5b: UDP and raw sockets are denied too, not just TCP ---");
    // Landlock's network access rights (ABI v4) are ConnectTcp and BindTcp —
    // there is no UDP, ICMP, or raw-socket right in any ABI. So Test 5 above,
    // on its own, leaves an app with "no network capability" holding
    // unrestricted UDP: DNS-tunnelled exfiltration, QUIC, arbitrary C2. The
    // second mechanism is in agent-init — CAP_NET_RAW dropped, plus a seccomp
    // filter refusing socket() for the datagram and raw families (see
    // packages/agent-init/src/seccomp.rs).
    //
    // Unlike every other denial check in this file, these two are asserted
    // unconditionally: seccomp-bpf and capability dropping work on Docker
    // Desktop's linuxkit kernel just as they do on a real host, so there is
    // no environment here to make an excuse for.
    const udpProbe = await rpc.call({
      id: "5b",
      export: "probe_network_udp",
      input: { host: "1.1.1.1", port: 53 },
    });
    console.log("udp response:", udpProbe);
    assert(!udpProbe.error, `probe_network_udp itself errored (unexpected): ${udpProbe.error}`);
    assert(
      udpProbe.result?.sent === false,
      `an app with no declared network capability sent a UDP datagram — seccomp filter missing or not applied: ${JSON.stringify(udpProbe)}`,
    );
    assert(
      /EPERM|not permitted|denied/i.test(udpProbe.result?.error ?? ""),
      `UDP send failed, but not with a permission error — the denial must come from the seccomp filter, not from the network being unreachable: ${JSON.stringify(udpProbe)}`,
    );

    const rawProbe = await rpc.call({
      id: "5c",
      export: "probe_raw_socket",
      input: { host: "1.1.1.1" },
    });
    console.log("raw-socket response:", rawProbe);
    assert(!rawProbe.error, `probe_raw_socket itself errored (unexpected): ${rawProbe.error}`);
    assert(
      rawProbe.result?.opened === false,
      `an app with no declared network capability opened a raw/ICMP socket — CAP_NET_RAW is still present: ${JSON.stringify(rawProbe)}`,
    );
    assert(
      /EPERM|not permitted|denied/i.test(rawProbe.result?.error ?? ""),
      `ping failed for some reason other than being refused a socket, so this proves nothing: ${JSON.stringify(rawProbe)}`,
    );
    console.log("\nPASS — UDP and raw sockets are refused for an app declaring no network capability.");

    console.log("\n--- Test 6: symlink escape — a symlink INSIDE the declared path pointing OUTSIDE it ---");
    // PathBeneath rules bind to a real inode hierarchy (resolved when
    // agent-init opens the path via PathFd::new(), see main.rs), not a path
    // string — so Landlock is expected to resolve a symlink at syscall time
    // and deny access to whatever it actually points at, even though the
    // symlink itself lives inside the granted /workspace hierarchy. This is
    // the classic "escape the sandbox via a symlink" technique; proving it
    // doesn't work here is what makes the write/read-path grants above mean
    // anything against an app that tries to plant one.
    await execInContainer(running.container, ["sh", "-c", "ln -sfn /opt /workspace/escape-write-link"]);
    const symlinkWrite = await rpc.call({
      id: "6",
      export: "write_file",
      input: { path: "escape-write-link/pwned-via-symlink.txt", content: "if this exists, symlink escape worked" },
    });
    console.log("write response:", symlinkWrite);
    const symlinkWriteDenied = symlinkWrite.error && /EACCES|EPERM|permission/i.test(symlinkWrite.error);

    await execInContainer(running.container, ["sh", "-c", "ln -sfn /opt /workspace/escape-read-link"]);
    const symlinkRead = await rpc.call({
      id: "7",
      export: "read_file",
      input: { path: "escape-read-link/berth-should-not-be-readable.txt" },
    });
    console.log("read response:", symlinkRead);
    const symlinkReadDenied = symlinkRead.error && /EACCES|EPERM|permission/i.test(symlinkRead.error);

    if (landlockActive) {
      assert(
        symlinkWriteDenied,
        `Landlock is active but a write through a symlink pointing outside /workspace was NOT denied — real regression: ${JSON.stringify(symlinkWrite)}`,
      );
      assert(
        symlinkReadDenied,
        `Landlock is active but a read through a symlink pointing outside the declared read paths was NOT denied — real regression: ${JSON.stringify(symlinkRead)}`,
      );
      console.log("\nPASS — the kernel resolved both symlinks to their real target and denied access outside the declared paths.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    console.log("\n--- Test 7: concurrent access at the boundary — enforcement must hold under load, not just serially ---");
    // There's no real TOCTOU window in this architecture to race against:
    // agent-init calls restrict_self() and the ruleset is immutable for the
    // rest of the process's life, all *before* exec() replaces the process
    // image — so the app itself never runs for even one syscall without the
    // policy already applied (see main.rs's comment on why write_paths are
    // created ahead of PathFd::new(), not after). What IS worth stress-
    // testing is this app's own RPC dispatch: every test above issued one
    // call at a time — this fires a burst of in-scope and out-of-scope
    // writes concurrently, on the same restricted process, to catch any
    // reordering or partial-completion bug in the app's own request handling
    // that a serial test would never expose.
    const CONCURRENCY = 20;
    const [insideResults, outsideResults] = await Promise.all([
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          rpc.call({ id: `8-inside-${i}`, export: "write_file", input: { path: `concurrent-inside-${i}.txt`, content: "ok" } }),
        ),
      ),
      Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          rpc.call({
            id: `8-outside-${i}`,
            export: "write_file",
            input: { path: `../../../etc/berth-concurrent-${i}.txt`, content: "if any of these exist, enforcement raced" },
          }),
        ),
      ),
    ]);
    const insideFailures = insideResults.filter((r) => r.error);
    const outsideDenials = outsideResults.filter((r) => r.error && /EACCES|EPERM|permission/i.test(r.error));
    console.log(`inside: ${insideResults.length - insideFailures.length}/${CONCURRENCY} succeeded; outside: ${outsideDenials.length}/${CONCURRENCY} denied`);
    assert(insideFailures.length === 0, `expected every concurrent in-scope write to succeed, ${insideFailures.length} failed: ${JSON.stringify(insideFailures)}`);
    if (landlockActive) {
      assert(
        outsideDenials.length === CONCURRENCY,
        `Landlock is active but only ${outsideDenials.length}/${CONCURRENCY} concurrent out-of-scope writes were denied — a real race would show up as a partial count here: ${JSON.stringify(outsideResults)}`,
      );
      console.log("\nPASS — every one of 20 concurrent out-of-scope writes was denied; enforcement held under load, not just serially.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    console.log("\n--- Test 10: truncate(2) outside the declared write path ---");
    // Landlock only enforces the access rights named in handled_access_fs, so
    // a right that isn't handled is permitted *everywhere* — not merely
    // ungranted. agent-init's handled set used to be an enumerated list that
    // omitted AccessFs::Truncate (ABI V3), which meant the write denial Test 2
    // proves had a clean bypass: open(O_WRONLY) on a path outside /workspace
    // was refused, while truncate(path, 0) on that same path succeeded and
    // destroyed its contents just as effectively. This runs both halves — the
    // in-scope truncate must still work (handling a right must not break the
    // grants that were already correct) and the out-of-scope one must not.
    //
    // The out-of-scope target is the /opt file Test 4 created via docker exec;
    // it has to genuinely exist, or truncate() returns ENOENT from ordinary
    // VFS lookup before Landlock's check is reached and the denial below would
    // prove nothing (same reasoning as Test 4's own comment).
    const insideTruncate = await rpc.call({ id: "10-inside", export: "truncate_file", input: { path: "allowed.txt", size: 0 } });
    console.log("inside response:", insideTruncate);
    assert(!insideTruncate.error, `expected truncate inside /workspace to succeed, got error: ${insideTruncate.error}`);

    const outsideTruncate = await rpc.call({
      id: "10-outside",
      export: "truncate_file",
      input: { path: "../../../opt/berth-should-not-be-readable.txt", size: 0 },
    });
    console.log("outside response:", outsideTruncate);
    const truncateDenied = outsideTruncate.error && /EACCES|EPERM|permission/i.test(outsideTruncate.error);
    if (landlockActive) {
      assert(
        truncateDenied,
        `Landlock is active but truncate() outside the declared write path was NOT denied — AccessFs::Truncate is missing from agent-init's handled set: ${JSON.stringify(outsideTruncate)}`,
      );
      console.log("\nPASS — truncate() outside /workspace was refused by the kernel, same as an ordinary write.");
    } else {
      console.log(
        truncateDenied
          ? "\n(Interesting: denied anyway, despite ruleset != Enforced — logged for information, not asserted.)"
          : "\nNOT VERIFIED (expected in this environment) — the truncate succeeded because Landlock isn't enforced here.",
      );
    }

    console.log("\n--- Test 11: creating a user namespace, which would undo the capability drop ---");
    // agent-init drops CAP_SYS_ADMIN, CAP_NET_ADMIN, and CAP_NET_RAW from the
    // bounding set before exec-ing the runtime, and the bounding set is what
    // makes that stick across execve(). But creating a user namespace requires
    // no privilege at all, and the kernel gives its creator a fresh
    // CAP_FULL_SET bounding set *inside* the new namespace. So `unshare -Urm`
    // handed back everything the drop had just removed, and mount(2) — which
    // Landlock does not cover — worked again. Reproduced in the real
    // berth/filesystem image during the audit; see REMEDIATION.md 1.3.
    //
    // Docker's own default seccomp profile blocks this, which is why it is not
    // a problem for containers generally. It stops doing so when the container
    // holds CAP_SYS_ADMIN — which every Berth container does, unconditionally,
    // for semantic-fs's FUSE mount. The fix is a seccomp filter agent-init
    // installs itself (packages/agent-init/src/seccomp.rs).
    //
    // Asserted unconditionally, like Test 5b and unlike every Landlock check in
    // this file: seccomp-bpf works on Docker Desktop's linuxkit kernel exactly
    // as it does on a real host, so there is no environment here to make an
    // excuse for.
    const nsProbe = await rpc.call({ id: "11", export: "probe_user_namespace" });
    console.log("response:", nsProbe);
    assert(!nsProbe.error, `probe_user_namespace itself errored (unexpected): ${nsProbe.error}`);
    assert(
      nsProbe.result?.regainedCaps === false,
      `an app regained CAP_SYS_ADMIN and mounted a filesystem via unshare(CLONE_NEWUSER) — the capability drop is reversible again: ${JSON.stringify(nsProbe)}`,
    );
    assert(
      nsProbe.result?.created === false,
      `unshare(CLONE_NEWUSER) succeeded — the mount happened not to work this time, but the namespace was created, so the drop is one step from being reversible: ${JSON.stringify(nsProbe)}`,
    );
    assert(
      /EPERM|not permitted|denied/i.test(nsProbe.result?.error ?? ""),
      `unshare failed for some reason other than being refused, so this proves nothing: ${JSON.stringify(nsProbe)}`,
    );
    console.log("\nPASS — unshare(CLONE_NEWUSER) was refused, so the capability bounding-set drop is a real ceiling.");

    rpc.close();
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }

  console.log("\n--- Test 8: BERTH_REQUIRE_ENFORCEMENT=1 refuses to boot unrestricted ---");
  // A second, independent container from the same image — proves
  // agent-init's fail-closed gate (packages/agent-init/src/main.rs) without
  // touching the container Test 1-7 already tore down.
  const enforcedRunning = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-capability-enforcement-filesystem-require-enforcement",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    env: { BERTH_REQUIRE_ENFORCEMENT: "1" },
    docker,
  });
  const enforcedLog = await startLogCapture(enforcedRunning.container);
  try {
    if (landlockActive) {
      // Enforcement is genuinely FullyEnforced/PartiallyEnforced here, so the
      // gate must not interfere with a boot that would have passed anyway.
      await waitFor(() => /"filesystem" ready/.test(enforcedLog.text()), 20000, "filesystem runtime ready under BERTH_REQUIRE_ENFORCEMENT");
      console.log("\nPASS — BERTH_REQUIRE_ENFORCEMENT=1 did not block a correctly-enforced boot.");
    } else {
      // This host can't fully enforce the policy — agent-init must refuse to
      // exec the app at all rather than falling back to today's warn-and-run.
      await waitFor(
        () => /capability_enforcement_refused/.test(enforcedLog.text()),
        10000,
        "agent-init's capability_enforcement_refused audit line",
      );
      await waitFor(
        async () => !(await enforcedRunning.container.inspect()).State.Running,
        10000,
        "container to exit after agent-init's enforcement refusal",
      );
      const finalInspect = await enforcedRunning.container.inspect();
      assert(
        finalInspect.State.ExitCode !== 0,
        `expected a non-zero exit code when enforcement couldn't be verified, got ${finalInspect.State.ExitCode}`,
      );
      console.log("\nPASS — BERTH_REQUIRE_ENFORCEMENT=1 refused to exec unrestricted and exited non-zero.");
    }
  } finally {
    await enforcedLog.stop();
    await stopContainer(enforcedRunning.container).catch(() => {});
  }

  console.log("\n--- Test 9: cross-app boundary — one app's grant must not reach a sibling app's directory ---");
  // boundary-app-a/-b (test/fixtures) are each scoped ONLY to their own
  // /workspace/apps/boundary-app-<x> subdirectory (unlike filesystem's own
  // broad filesystem:write:/workspace grant, which legitimately covers the
  // whole tree and so proves nothing about cross-app isolation). Both run in
  // the SAME container via the real --apps multi-app path (see
  // multi-app-milestone.mjs) — each gets its own independent agent-init/
  // Landlock ruleset, and this proves app A's ruleset doesn't leak into app
  // B's directory just because they share a container and a bind mount.
  const boundaryAManifest = await loadManifest(join(BOUNDARY_APP_A_DIR, "berth.yml"));
  const boundaryBManifest = await loadManifest(join(BOUNDARY_APP_B_DIR, "berth.yml"));
  const boundaryCManifest = await loadManifest(join(BOUNDARY_APP_C_DIR, "berth.yml"));

  console.log("Building boundary-app-a's dev image (shared by both apps in this container)...");
  await buildImage({ appDir: BOUNDARY_APP_A_DIR, tag: "berth/boundary-app-a:dev", target: "dev", docker });

  const BOUNDARY_APP_A_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-a";
  const BOUNDARY_APP_B_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-b";
  const BOUNDARY_APP_C_CONTAINER_DIR = "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-c";
  const boundaryApps = [
    { name: "boundary-app-a", workingDir: BOUNDARY_APP_A_CONTAINER_DIR, manifest: boundaryAManifest },
    { name: "boundary-app-b", workingDir: BOUNDARY_APP_B_CONTAINER_DIR, manifest: boundaryBManifest },
    { name: "boundary-app-c", workingDir: BOUNDARY_APP_C_CONTAINER_DIR, manifest: boundaryCManifest },
  ];
  const boundaryRunning = await startContainer({
    image: "berth/boundary-app-a:dev",
    name: "berth-capability-enforcement-boundary",
    manifest: boundaryAManifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: BOUNDARY_APP_A_CONTAINER_DIR,
    apps: boundaryApps,
    docker,
  });
  const boundaryLog = await startLogCapture(boundaryRunning.container);
  try {
    await waitFor(() => /"boundary-app-a" ready/.test(boundaryLog.text()), 20000, "boundary-app-a runtime ready");
    await waitFor(() => /"boundary-app-b" ready/.test(boundaryLog.text()), 20000, "boundary-app-b runtime ready");
    await waitFor(() => /"boundary-app-c" ready/.test(boundaryLog.text()), 20000, "boundary-app-c runtime ready");

    // Seed a file only boundary-app-b is allowed to touch, via app B itself
    // (not a raw docker exec) so it's a real write through B's own ruleset.
    const seedResp = await invokeAppExport(boundaryRunning.container, "boundary-app-b", {
      id: "1",
      export: "write_file",
      input: { path: "b-owned.txt", content: "only boundary-app-b should be able to write or read this" },
    });
    assert(!seedResp.error, `boundary-app-b seeding its own file failed unexpectedly: ${seedResp.error}`);

    console.log("\n--- App A attempting to WRITE into App B's directory via relative traversal ---");
    const crossWrite = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "2",
      export: "write_file",
      input: { path: "../boundary-app-b/pwned-by-a.txt", content: "if this exists, cross-app isolation failed" },
    });
    console.log("response:", crossWrite);
    const crossWriteDenied = crossWrite.error && /EACCES|EPERM|permission/i.test(crossWrite.error);

    console.log("\n--- App A attempting to READ App B's file via relative traversal ---");
    const crossRead = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "3",
      export: "read_file",
      input: { path: "../boundary-app-b/b-owned.txt" },
    });
    console.log("response:", crossRead);
    const crossReadDenied = crossRead.error && /EACCES|EPERM|permission/i.test(crossRead.error);

    if (landlockActive) {
      assert(
        crossWriteDenied,
        `Landlock is active but boundary-app-a was able to write into boundary-app-b's directory — cross-app isolation regression: ${JSON.stringify(crossWrite)}`,
      );
      assert(
        crossReadDenied,
        `Landlock is active but boundary-app-a was able to read boundary-app-b's file — cross-app isolation regression: ${JSON.stringify(crossRead)}`,
      );
      console.log("\nPASS — sharing a container did not let app A reach app B's declared scope.");
    } else {
      console.log("\nNOT VERIFIED (expected in this environment) — Landlock isn't enforced here.");
    }

    // --- The RPC-socket half of the same boundary: REMEDIATION.md 1.4. ---
    //
    // Asserted UNCONDITIONALLY, unlike everything above it in this test, and
    // that is the point. The filesystem assertions above are Landlock, so they
    // degrade to informational on a kernel that doesn't enforce it (Docker
    // Desktop's linuxkit). This one is DAC — a 0710 directory owned by the
    // serving app's uid — which every kernel that runs a container enforces.
    // If it starts passing conditionally, something has silently reverted to
    // running apps as root.
    //
    // Deliberately not "can app A write into app B's socket directory": an app
    // does not need write access to *connect* to a pathname socket (Landlock
    // hooks neither, and the design doc works through why), so the only
    // meaningful assertion is the connect itself.
    console.log("\n--- App A attempting to CONNECT to app B's RPC socket (the 1.4 exploit) ---");
    const ownSocket = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "4",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-a/rpc.sock" },
    });
    console.log("app A -> its own socket:", ownSocket);
    // The positive control, and it has to come first: every denial below would
    // also "pass" if the sockets had simply moved somewhere nothing binds, or
    // if probe_unix_socket were broken.
    assert(
      ownSocket.result?.connected === true,
      `boundary-app-a could not reach its OWN RPC socket (${JSON.stringify(ownSocket)}) — the denial below would prove nothing`,
    );

    const siblingSocket = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "5",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-b/rpc.sock" },
    });
    console.log("app A -> app B's socket:", siblingSocket);
    assert(
      siblingSocket.result?.connected === false,
      `boundary-app-a reached boundary-app-b's RPC socket — REMEDIATION.md 1.4 has regressed and one app can invoke another's exports with its capabilities: ${JSON.stringify(siblingSocket)}`,
    );
    assert(
      /^(EACCES|EPERM)$/.test(siblingSocket.result?.code ?? ""),
      `boundary-app-a's connect to boundary-app-b's socket failed with "${siblingSocket.result?.code}" rather than EACCES/EPERM — that is not the kernel refusing it, which is what this test is for`,
    );

    // And the socket the old layout used must not be there at all: an app
    // rebinding /tmp/berth-rpc/<name>.sock would restore the whole exploit,
    // since /tmp itself is still traversable by everyone.
    const oldPathSocket = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "6",
      export: "probe_unix_socket",
      input: { path: "/tmp/berth-rpc/boundary-app-b.sock" },
    });
    console.log("app A -> app B's pre-1.4 socket path:", oldPathSocket);
    assert(
      oldPathSocket.result?.connected === false,
      `something is still listening at the pre-1.4 world-writable socket path: ${JSON.stringify(oldPathSocket)}`,
    );

    // And the authorized direction: app C is identical to app A except that its
    // berth.yml declares app:invoke:boundary-app-b. Without this half, the
    // denial above would be satisfied just as well by a boundary nothing can
    // cross — including @berth/agents' agent-as-tool path, which is the reason
    // an opt-in exists at all.
    console.log("\n--- App C, which DECLARED app:invoke:boundary-app-b, on its own peer socket ---");
    const grantedSocket = await invokeAppExport(boundaryRunning.container, "boundary-app-c", {
      id: "7",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-b/peers/boundary-app-c/rpc.sock" },
    });
    console.log("app C -> its peer socket on app B:", grantedSocket);
    assert(
      grantedSocket.result?.connected === true,
      `boundary-app-c declares app:invoke:boundary-app-b but was still refused (${JSON.stringify(grantedSocket)}) — the grant is not being wired up at boot`,
    );

    // Declaring the capability must not be transitive: C may reach B, which
    // says nothing about C reaching A.
    const ungrantedDirection = await invokeAppExport(boundaryRunning.container, "boundary-app-c", {
      id: "8",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-a/rpc.sock" },
    });
    console.log("app C -> app A's socket:", ungrantedDirection);
    assert(
      ungrantedDirection.result?.connected === false,
      `boundary-app-c reached boundary-app-a, which it never declared app:invoke: on: ${JSON.stringify(ungrantedDirection)}`,
    );

    // --- Identity, not just reachability: REMEDIATION.md 1.4 part 3. ---
    //
    // The per-caller socket is what lets the server say which sibling called
    // it. Two things have to hold for that to be a boundary rather than a
    // convention: an authorized caller cannot use *another* caller's channel,
    // and the target's own general-purpose socket is not a way around it.
    // App A, which declared nothing, against the channel B keeps for C. This is
    // the impersonation case: if it were reachable, A could invoke B's exports
    // and be recorded as C.
    const impersonation = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "9",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-b/peers/boundary-app-c/rpc.sock" },
    });
    console.log("app A -> the socket app B keeps for app C:", impersonation);
    assert(
      impersonation.result?.code === "EACCES",
      `boundary-app-a was not refused with EACCES on the channel boundary-app-b keeps for boundary-app-c — it could invoke exports while being attributed to another app: ${JSON.stringify(impersonation)}`,
    );

    const backDoor = await invokeAppExport(boundaryRunning.container, "boundary-app-c", {
      id: "10",
      export: "probe_unix_socket",
      input: { path: "/run/berth/boundary-app-b/rpc.sock" },
    });
    console.log("app C -> app B's relay socket:", backDoor);
    assert(
      backDoor.result?.connected === false,
      `boundary-app-c reached boundary-app-b's root-only socket, which carries no caller identity: ${JSON.stringify(backDoor)}`,
    );

    // And the identity actually reaches the server, rather than merely being
    // derivable from the layout: a real call over the peer socket, and B's own
    // audit line naming who made it. This is also the first assertion here
    // that exercises the whole exploit shape end to end — app C executing an
    // export with app B's capabilities — except that it is now the authorized
    // case, so it should succeed and be attributed.
    const attributed = await invokeAppExport(boundaryRunning.container, "boundary-app-c", {
      id: "11",
      export: "invoke_via_socket",
      input: {
        path: "/run/berth/boundary-app-b/peers/boundary-app-c/rpc.sock",
        export: "write_file",
        input: { path: "written-for-c.txt", content: "written by B, on C's behalf" },
      },
    });
    console.log("app C -> write_file on app B:", attributed);
    assert(
      /"id"\s*:\s*"x"/.test(attributed.result?.response ?? "") && !/error/.test(attributed.result?.response ?? ""),
      `app C's authorized call to app B did not return a clean response: ${JSON.stringify(attributed)}`,
    );
    await waitFor(
      () => /"boundary-app-c" invoked export "write_file"/.test(boundaryLog.text()),
      5000,
      'boundary-app-b to attribute the call to "boundary-app-c"',
    );
    // The file must exist and must be inside B's scope — proof the call really
    // ran with B's capabilities and not C's.
    const writtenBack = await invokeAppExport(boundaryRunning.container, "boundary-app-b", {
      id: "12",
      export: "read_file",
      input: { path: "written-for-c.txt" },
    });
    assert(
      writtenBack.result?.content === "written by B, on C's behalf",
      `expected app B to have written the file on C's behalf, got ${JSON.stringify(writtenBack)}`,
    );

    // The boot must survive a grant naming an app that isn't here — C declares
    // app:invoke:no-such-app, and every assertion above depends on C having
    // started at all.
    assert(
      /no app named no-such-app is in this container/.test(boundaryLog.text()),
      "expected a warning for boundary-app-c's app:invoke:no-such-app; without one, the unknown-target path is untested",
    );

    console.log("\nPASS — an app reaches a sibling's RPC socket only where app:invoke: declared it (REMEDIATION.md 1.4).");

    // --- The daemons' identity, REMEDIATION.md 1.14. ---
    //
    // Both the context bus and semantic-fs used to take the caller's own word
    // for which app it is, so any app could publish under another's name or
    // poison semantic-fs's write attribution. Both now derive it from
    // SO_PEERCRED. Asserted on the daemon's own log line rather than on a
    // response, because both daemons ack a register either way — the point is
    // not that the call fails, it is that the name recorded is not the one
    // sent.
    console.log("\n--- App A registering with both daemons under app B's name ---");
    const busSpoof = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "13",
      export: "register_on_bus",
      input: { app: "boundary-app-b" },
    });
    assert(busSpoof.result?.ok === true, `the context-bus register probe did not run: ${JSON.stringify(busSpoof)}`);
    await waitFor(
      () => /\[context-bus\].*claimed to be "boundary-app-b" but the kernel says App\("boundary-app-a"\)/.test(boundaryLog.text()),
      5000,
      "context-bus to override boundary-app-a's claim to be boundary-app-b",
    );
    assert(
      /\[context-bus\] conn \d+ registered as "boundary-app-a"/.test(boundaryLog.text()),
      "context-bus overrode the claim but did not register the connection under the kernel's answer",
    );

    // pid 1 is the deliberate part: registering *another* process's pid is how
    // an app would attribute its own /context writes to something else, and
    // the pid is now taken from SO_PEERCRED too, not from the request.
    const fsSpoof = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "14",
      export: "register_on_semantic_fs",
      input: { app: "boundary-app-b", pid: 1 },
    });
    assert(fsSpoof.result?.ok === true, `the semantic-fs register probe did not run: ${JSON.stringify(fsSpoof)}`);
    await waitFor(
      () => /\[semantic-fs:control\].*registered as "boundary-app-b" but the kernel says "boundary-app-a"/.test(boundaryLog.text()),
      5000,
      "semantic-fs to override boundary-app-a's claim to be boundary-app-b",
    );

    // The allocation half of the same item: a 0xFFFFFFFF length header. The
    // assertion is that the daemon is still there afterwards and still serving
    // *other* connections — a daemon that died would fail the register below,
    // and one that allocated 4 GiB would likely take the container with it.
    console.log("\n--- App A sending an oversized frame header to both daemons ---");
    for (const socketPath of ["/tmp/berth-context-bus.sock", "/tmp/berth-semantic-fs.sock"]) {
      const oversized = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
        id: "15",
        export: "send_oversized_frame",
        input: { path: socketPath },
      });
      assert(oversized.result?.ok === true, `the oversized-frame probe did not reach ${socketPath}: ${JSON.stringify(oversized)}`);
    }
    const survived = await invokeAppExport(boundaryRunning.container, "boundary-app-a", {
      id: "16",
      export: "register_on_bus",
      input: { app: "boundary-app-a" },
    });
    assert(survived.result?.ok === true, `the context bus stopped accepting connections after an oversized frame header: ${JSON.stringify(survived)}`);
    const registrations = boundaryLog.text().match(/\[context-bus\] conn \d+ registered as/g) ?? [];
    assert(
      registrations.length >= 2,
      `expected the context bus to serve a fresh registration after the oversized frame, saw ${registrations.length}`,
    );

    console.log("\nPASS — both daemons record the uid the kernel reports, not the name the caller sent, and survive a 4 GiB length header (REMEDIATION.md 1.14).");
  } finally {
    await boundaryLog.stop();
    await stopContainer(boundaryRunning.container).catch(() => {});
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function execInContainer(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let out = "";
  stdout.on("data", (chunk) => (out += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => process.stderr.write(`[exec stderr] ${chunk}`));
  await new Promise((resolve) => stream.on("end", resolve));
  return out;
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

// One attach connection reused across every call — closing it (or ending
// the stream) after a single request tears down the container's actual
// stdin for good, breaking any subsequent RPC call against the same
// container.
async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  // Terminates the attach options object docker-modem sends as this POST's
  // body straight into the container's stdin, so it can't concatenate onto the
  // first real request — see @berth/docker-orchestrator's stdio-rpc.ts for the
  // full explanation.
  stream.write("\n");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 5000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        stream.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCAPABILITY ENFORCEMENT VERIFICATION FAILED:", err);
    process.exit(1);
  });
