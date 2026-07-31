import { existsSync } from "node:fs";

/**
 * VNC/Xvfb themselves are a container-level concern (entrypoint.sh starts
 * them before the SDK runtime, conditional on the browser:* capability) —
 * this is just a small guard so Chromium doesn't race Xvfb's startup and
 * try to attach to a display socket that isn't there yet.
 */
export function isDisplayReady(display = process.env.DISPLAY ?? ":99"): boolean {
  const socketNumber = display.replace(":", "");
  return existsSync(`/tmp/.X11-unix/X${socketNumber}`);
}

export async function waitForDisplay(display = process.env.DISPLAY ?? ":99", timeoutMs = 5000): Promise<void> {
  if (process.env.BERTH_TEST_MODE === "1") return; // headless in test mode, no display needed
  const start = Date.now();
  while (!isDisplayReady(display)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`X display ${display} not ready after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
