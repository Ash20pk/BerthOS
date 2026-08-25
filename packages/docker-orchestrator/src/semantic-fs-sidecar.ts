import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";

/**
 * The semantic-fs sidecar (BUILD_PLAN M1.1, docs/internal/design/sys-admin-drop.md).
 *
 * The FUSE mount for /context needs `mount(2)`, which needs CAP_SYS_ADMIN in
 * the mount namespace's owning user namespace — a capability granted at
 * container creation is the ceiling for everything inside, so a sandbox
 * whose `docker inspect` shows no SYS_ADMIN can never perform the mount
 * itself. It comes from outside instead: a per-sandbox sidecar container
 * runs semantic-fs-daemon with the cap, mounts into a host directory bound
 * with `rshared` propagation, and the sandbox receives the live mount as an
 * ordinary `rslave` bind — no capability, no /dev/fuse, no AppArmor
 * exception on the sandbox.
 *
 * Three shared surfaces, on two kinds of storage — the split matters:
 *   mnt  — the FUSE mountpoint, on a per-sandbox *host directory* (under
 *          $HOME so the daemon's VM can see it): mount propagation only
 *          works through a host bind, never a named volume. The sandbox
 *          binds it at /context.
 *   var  — backing store + SQLite index, on a *named volume*: it must hold
 *          real root:berth ownership and group modes, which chown cannot
 *          reliably set on a macOS virtiofs share. The sandbox binds the
 *          same volume read-only at /var/berth so `berth snapshot create`'s
 *          getArchive paths keep working unchanged.
 *   ctl  — the control socket, on a named volume for the same ownership
 *          reason (0660 root:berth is the whole access model). The sandbox
 *          binds it at /run/berth-fs; the SDK reads BERTH_SEMANTIC_FS_SOCKET.
 */
export const SIDECAR_EXPORT_DIR = "/berth-fs";
export const SANDBOX_FS_CTL_DIR = "/run/berth-fs";
export const SEMANTIC_FS_SOCKET_NAME = "berth-semantic-fs.sock";

const DEFAULT_RUN_DIR = join(homedir(), ".berth", "run");

export function sidecarName(sandboxName: string): string {
  return `${sandboxName}-fs`;
}

export function sidecarHostDir(sandboxName: string, runDir: string = DEFAULT_RUN_DIR): string {
  return join(runDir, sandboxName, "fs");
}

export interface StartSidecarOptions {
  sandboxName: string;
  /** The sandbox's own image — it already contains the daemon binary. */
  image: string;
  docker: Docker;
  runDir?: string;
  /** How long to wait for the FUSE mount to appear before failing over. */
  mountTimeoutMs?: number;
  /**
   * Extra binds for the *sidecar*, already mapped to SIDECAR_EXPORT_DIR
   * paths — how `berth snapshot restore`'s pre-populated context-data and
   * index reach the daemon, which now lives here rather than in the sandbox.
   */
  extraBinds?: string[];
  /**
   * "app=uid,app=uid" — the same 10000+index assignment entrypoint.sh's
   * provision_app_identity makes. The daemon attributes FUSE writes by uid
   * here, because in the sidecar's pid namespace a request's pid is
   * untranslatable (see PidRegistry.Attribute).
   */
  appUidMap?: string;
}

export interface RunningSidecar {
  container: Docker.Container;
  hostDir: string;
  /** Binds the *sandbox* must add to receive the mount, data view, and socket. */
  sandboxBinds: string[];
  /** Env the sandbox needs so the SDK finds the relocated control socket. */
  sandboxEnv: Record<string, string>;
}

async function execCapture(container: Docker.Container, cmd: string[]): Promise<{ output: string; exitCode: number | null }> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const { ExitCode } = await exec.inspect();
  return { output: Buffer.concat(chunks).toString("utf-8"), exitCode: ExitCode ?? null };
}

/**
 * Starts the sidecar and waits until the FUSE mount is live at
 * <hostDir>/mnt. Throws on any failure — the caller decides whether that
 * means "fall back to the legacy in-sandbox mount" (startContainer does,
 * loudly) or "fail the boot".
 */
export function sidecarVolumeNames(sandboxName: string): { varVolume: string; ctlVolume: string } {
  return { varVolume: `${sandboxName}-fs-var`, ctlVolume: `${sandboxName}-fs-ctl` };
}

export async function startSemanticFsSidecar(options: StartSidecarOptions): Promise<RunningSidecar> {
  const { docker } = options;
  const hostDir = sidecarHostDir(options.sandboxName, options.runDir);
  // A per-boot mountpoint, because the previous boot's FUSE mount can
  // outlive its sidecar (SIGKILL never unmounts): a stale mountpoint makes
  // Docker's own mount-source stat fail and the whole sidecar path
  // collapse to the legacy fallback. The sidecar's entrypoint lazily
  // unmounts and removes its predecessors' mnt-* before mounting its own —
  // it is the one process here holding the capability to do so.
  const mountId = randomBytes(6).toString("hex");
  const mnt = join(hostDir, `mnt-${mountId}`);
  await mkdir(hostDir, { recursive: true });
  await mkdir(mnt, { recursive: true }).catch(() => {});
  const { varVolume, ctlVolume } = sidecarVolumeNames(options.sandboxName);

  const name = sidecarName(options.sandboxName);
  await docker.getContainer(name).remove({ force: true }).catch(() => {});

  const container = await docker.createContainer({
    name,
    Image: options.image,
    // A one-line shell wrapper, then the daemon — not entrypoint.sh. This
    // container exists to hold one process and one privilege; the wrapper's
    // only job is sweeping predecessors' stale mountpoints (see mountId).
    Entrypoint: [
      "sh",
      "-c",
      `for m in ${SIDECAR_EXPORT_DIR}/mnt-*; do [ "$m" = "${SIDECAR_EXPORT_DIR}/mnt-${mountId}" ] && continue; umount -l "$m" 2>/dev/null; rmdir "$m" 2>/dev/null; done; exec /usr/local/bin/semantic-fs-daemon`,
    ],
    Cmd: [],
    Env: [
      `BERTH_CONTEXT_MOUNT=${SIDECAR_EXPORT_DIR}/mnt-${mountId}`,
      `BERTH_CONTEXT_DATA=${SIDECAR_EXPORT_DIR}/var/context-data`,
      `BERTH_CONTEXT_INDEX_DB=${SIDECAR_EXPORT_DIR}/var/context-index.db`,
      `BERTH_SEMANTIC_FS_SOCKET=${SIDECAR_EXPORT_DIR}/ctl/${SEMANTIC_FS_SOCKET_NAME}`,
      // The sandbox's apps hold this supplementary gid (base.Dockerfile's
      // `berth` group); DAC compares numbers, so the socket's group grant
      // crosses the container boundary intact.
      "BERTH_SHARED_GID=9999",
      ...(options.appUidMap ? [`BERTH_APP_UID_MAP=${options.appUidMap}`] : []),
    ],
    HostConfig: {
      // rshared is the whole mechanism: the FUSE mount performed inside this
      // container propagates back through the bind to the host side, where
      // the sandbox's rslave bind picks it up.
      Binds: [
        `${hostDir}:${SIDECAR_EXPORT_DIR}:rshared`,
        `${varVolume}:${SIDECAR_EXPORT_DIR}/var`,
        `${ctlVolume}:${SIDECAR_EXPORT_DIR}/ctl`,
        ...(options.extraBinds ?? []),
      ],
      CapAdd: ["SYS_ADMIN"],
      Devices: [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }],
      SecurityOpt: ["apparmor:unconfined"],
      AutoRemove: false,
    },
  });
  await container.start();

  // The mount is live when the sidecar's own mount table says so. Checked
  // from inside the sidecar (docker exec) rather than from the host, because
  // on macOS the host is not the machine the mount happens on.
  const timeout = options.mountTimeoutMs ?? 15000;
  const deadline = Date.now() + timeout;
  let lastState = "";
  while (Date.now() < deadline) {
    const probe = await execCapture(container, ["sh", "-c", `grep " ${SIDECAR_EXPORT_DIR}/mnt-${mountId} fuse" /proc/mounts`]).catch(
      () => ({ output: "", exitCode: 1 }),
    );
    if (probe.exitCode === 0) {
      return {
        container,
        hostDir,
        sandboxBinds: [
          `${mnt}:/context:rslave`,
          // Read-only: nothing in the sandbox writes the backing store
          // directly (apps go through the FUSE mount), and this view exists
          // so `berth snapshot create`'s default getArchive paths keep
          // working without knowing the sidecar exists.
          `${varVolume}:/var/berth:ro`,
          `${ctlVolume}:${SANDBOX_FS_CTL_DIR}`,
        ],
        sandboxEnv: {
          BERTH_SEMANTIC_FS_SOCKET: `${SANDBOX_FS_CTL_DIR}/${SEMANTIC_FS_SOCKET_NAME}`,
          BERTH_SEMANTIC_FS_EXTERNAL: "1",
        },
      };
    }
    lastState = probe.output;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Failed to mount — collect the daemon's own account before tearing down,
  // so the fallback warning can say why rather than just "didn't".
  const logs = await container
    .logs({ stdout: true, stderr: true, tail: 20 })
    .then((buffer) => buffer.toString("utf-8"))
    .catch(() => "(no logs)");
  await container.remove({ force: true }).catch(() => {});
  throw new Error(
    `semantic-fs sidecar's FUSE mount never appeared at ${SIDECAR_EXPORT_DIR}/mnt within ${timeout}ms ` +
      `(this host may not support rshared bind propagation). Daemon output:\n${logs}\nlast probe: ${lastState}`,
  );
}

/** Best-effort teardown, same posture as removeContainerSecretsDir. */
export async function stopSemanticFsSidecar(sandboxName: string, docker: Docker): Promise<void> {
  await docker.getContainer(sidecarName(sandboxName)).remove({ force: true }).catch(() => {});
  const { varVolume, ctlVolume } = sidecarVolumeNames(sandboxName);
  for (const volume of [varVolume, ctlVolume]) {
    await docker.getVolume(volume).remove().catch(() => {});
  }
}
