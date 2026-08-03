import type Docker from "dockerode";

/**
 * The same inspect-to-verify-liveness idiom `berth logs`/`berth rpc`/`berth
 * mcp`/`berth snapshot create` already use to confirm a deterministically-
 * named container is actually still running before doing anything else.
 */
export async function isContainerRunning(docker: Docker, containerName: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(containerName).inspect();
    return info.State.Running;
  } catch {
    return false;
  }
}

/**
 * `berth os up` reuses a deterministic container name (`berth-os-<name>`)
 * across runs, so it only works when nothing already holds that name.
 * `berth os down` guarantees that by stopping *and* removing the container.
 * But a container that crashed, got OOM-killed, or was stopped some other
 * way (a plain `docker stop`, a host reboot) is still registered under that
 * name — Docker never removes a stopped container on its own — so a plain
 * `docker.createContainer({name, ...})` call fails with a raw "name already
 * in use" 409 instead of the same clean message `isContainerRunning` lets
 * callers show for the "still running" case. Removes any such leftover
 * container so the caller can rebuild fresh; a no-op (returns false) if
 * nothing is registered under this name at all.
 */
export async function removeStaleContainer(docker: Docker, containerName: string): Promise<boolean> {
  const container = docker.getContainer(containerName);
  try {
    await container.inspect();
  } catch {
    return false;
  }
  await container.remove({ force: true });
  return true;
}
