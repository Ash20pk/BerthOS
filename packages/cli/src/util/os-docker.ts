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
