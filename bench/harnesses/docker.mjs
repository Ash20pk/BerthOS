// Harness adapter: plain Docker, in the configuration a developer actually
// gets when they reach for a container to run an agent in.
//
// That means the defaults: the workload runs as root, no user namespace
// remapping, no seccomp beyond Docker's own profile, secrets delivered the one
// way `docker run` delivers them (`-e`), and the whole filesystem writable.
// This is the baseline the benchmark exists to compare against, so it is
// deliberately not hardened — and equally deliberately not sabotaged: nothing
// here adds a capability or drops a protection Docker gives you by default.
//
// The exact create options land in the results file, so anyone who thinks the
// baseline was unfair can read what was actually run.

import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { PROBE_CHECK_IDS } from "../checks.mjs";

// The same node:22-alpine digest packages/docker-orchestrator/docker/base.Dockerfile
// pins, so this runs the identical userland Berth's own image is built on —
// one less difference between the two columns.
const IMAGE = "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const CONTAINER_NAME = "berth-bench-docker";
const WORKLOAD_UID = 10000;
const SIBLING_UID = 10001;

export async function execCapture(docker, container, cmd, user) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, ...(user ? { User: user } : {}) });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  const out = [];
  const errOut = [];
  stdout.on("data", (c) => out.push(c));
  stderr.on("data", (c) => errOut.push(c));
  await new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  const { ExitCode } = await exec.inspect();
  return { stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(errOut).toString("utf-8"), exitCode: ExitCode };
}

export const harness = {
  id: "docker",
  title: "Plain Docker (defaults)",
  description: "`docker run` with default settings: workload as root, secrets via -e, whole filesystem writable.",

  async run({ probeDir, hostEndpoint, secretValue, log }) {
    const docker = new Docker();
    await docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => {});

    const dataDir = "/work/workload";
    const siblingDir = "/work/sibling";
    const foreignSecretPath = "/work/sibling/.secret.env";

    const createOptions = {
      Image: IMAGE,
      name: CONTAINER_NAME,
      // Sleep, then exec the probe: the same shape as a hosted sandbox's
      // "start a box, then run code in it" API.
      Cmd: ["sh", "-c", "sleep 600"],
      WorkingDir: "/work",
      Env: [
        // The only secret-delivery mechanism plain Docker has. That this shows
        // up in `docker inspect` is the finding, not a misconfiguration.
        `BENCH_WORKLOAD_SECRET=${secretValue}`,
        `BENCH_DATA_DIR=${dataDir}`,
        `BENCH_SIBLING_DIR=${siblingDir}`,
        `BENCH_FOREIGN_SECRET_PATH=${foreignSecretPath}`,
        ...(hostEndpoint ? [`BENCH_HOST_ENDPOINT=${hostEndpoint}`] : []),
      ],
      HostConfig: {
        Binds: [`${probeDir}:/bench:ro`],
        // So the host-reach row has a route to test at all. Docker Desktop
        // resolves this name on its own; on native Linux it needs saying.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        AutoRemove: false,
      },
    };

    log("booting the baseline container");
    const container = await docker.createContainer(createOptions);
    await container.start();

    try {
      // A co-tenant workload's directory and secret, set up the way a careful
      // operator would: owned by a different uid, mode 0700, secret 0600. On
      // this harness the probe still runs as root, which is the point.
      await execCapture(docker, container, [
        "sh",
        "-c",
        `mkdir -p ${dataDir} ${siblingDir} && ` +
          `echo "the co-tenant's data" > ${siblingDir}/sibling-owned.txt && ` +
          `echo "BENCH_SIBLING_SECRET=${secretValue}" > ${foreignSecretPath} && ` +
          `chown -R ${WORKLOAD_UID}:${WORKLOAD_UID} ${dataDir} && ` +
          `chown -R ${SIBLING_UID}:${SIBLING_UID} ${siblingDir} && ` +
          `chmod 700 ${siblingDir} && chmod 600 ${foreignSecretPath}`,
      ]);

      log("running the probe");
      const probe = await execCapture(docker, container, ["node", "/bench/probe.mjs", "--all"]);
      let probeResults;
      try {
        probeResults = JSON.parse(probe.stdout.trim().split("\n").pop());
      } catch (err) {
        throw new Error(`could not parse probe output (${err.message}): ${probe.stdout}${probe.stderr}`);
      }

      // --- host-side observations ------------------------------------------
      const info = await container.inspect();
      const envStrings = info.Config?.Env ?? [];
      const secretInEnv = envStrings.some((e) => e.includes(secretValue));
      const observations = {
        "secret-in-metadata": secretInEnv
          ? {
              outcome: "escaped",
              detail: "the secret is readable in `docker inspect` Config.Env — anyone with daemon access reads it without entering the sandbox",
            }
          : { outcome: "contained", detail: "the secret does not appear in container metadata" },
        "published-port-exposure": describePorts(info),
        "control-plane-exec": await probeControlPlane(docker, container),
      };

      return {
        probeResults,
        observations,
        meta: {
          image: IMAGE,
          createOptions,
          workloadUser: "root (Docker's default)",
        },
      };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  },
};

/**
 * Shared by both Docker-backed adapters. Writes the undeclared path from a
 * process injected through the daemon rather than from the workload — the
 * distinction that makes this row a real finding instead of a repeat of the
 * undeclared-write row.
 */
export async function probeControlPlane(docker, container) {
  const target = "/etc/berth-bench-control-plane.txt";
  const result = await execCapture(docker, container, ["sh", "-c", `echo injected > ${target} && echo WROTE`]);
  if (result.stdout.includes("WROTE")) {
    return {
      outcome: "escaped",
      detail: `a process injected through the container socket wrote ${target} — no in-sandbox policy binds it, because it is not a descendant of the restricted workload`,
    };
  }
  return { outcome: "contained", detail: `the injected process could not write ${target}: ${(result.stderr || result.stdout).trim().slice(0, 120)}` };
}

/** Shared by both Docker-backed adapters: what the daemon says is published, and to where. */
export function describePorts(info) {
  const bindings = info.HostConfig?.PortBindings ?? {};
  const published = Object.entries(bindings).filter(([, binds]) => Array.isArray(binds) && binds.length > 0);
  const beyondLoopback = published.filter(([, binds]) => binds.some((b) => b.HostIp && b.HostIp !== "127.0.0.1" && b.HostIp !== "localhost"));
  const cdp = published.filter(([port]) => port.startsWith("9222"));

  if (cdp.length > 0) {
    return { outcome: "escaped", detail: `the Chrome DevTools port is published to the host (${cdp.map(([p]) => p).join(", ")}) — full browser control, no authentication` };
  }
  if (beyondLoopback.length > 0) {
    return {
      outcome: "escaped",
      detail: `published beyond loopback: ${beyondLoopback.map(([p, b]) => `${p} → ${b.map((x) => x.HostIp || "0.0.0.0").join(",")}`).join("; ")}`,
    };
  }
  return {
    outcome: "contained",
    detail: published.length === 0 ? "no ports published to the host" : `published only on loopback: ${published.map(([p]) => p).join(", ")}`,
  };
}
