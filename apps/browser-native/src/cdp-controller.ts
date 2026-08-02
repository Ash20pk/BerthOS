import { chromium, type Browser, type Page } from "playwright-core";
import { waitForDisplay } from "./vnc.js";

let browserPromise: Promise<Browser> | undefined;
let pagePromise: Promise<Page> | undefined;

/**
 * Launches the system Chromium (via CHROME_BIN, not Playwright's bundled
 * download — the base image already ships chromium/chromium-chromedriver).
 * Visible (headless: false) against Xvfb so a human can watch it over VNC;
 * headless in BERTH_TEST_MODE so `berth test` doesn't need a display.
 *
 * `proxy` routes every request through entrypoint.sh's egress broker
 * (packages/docker-orchestrator/docker/egress-broker.js), which enforces
 * browser:navigate:<pattern> at the host level — this is a Chromium launch
 * flag (`--proxy-server` under the hood), so it applies browser-wide, not
 * per-navigation. Combined with the Landlock network grant narrowing to just
 * the broker's own port (see apps/browser-native/berth.yml), the kernel
 * backstops this app into only ever reaching the broker directly.
 */
export function launchChromium(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      await waitForDisplay();
      return chromium.launch({
        executablePath: process.env.CHROME_BIN,
        headless: process.env.BERTH_TEST_MODE === "1",
        proxy: { server: `http://127.0.0.1:${process.env.BERTH_EGRESS_BROKER_PORT ?? "8090"}` },
        args: [
          "--remote-debugging-port=9222",
          "--remote-debugging-address=0.0.0.0",
          "--no-sandbox",
          // Standard hardening for headless Chromium in a Docker/CI container,
          // not a local-dev-only concern: Docker's default /dev/shm (64MB) is
          // well below what Chromium's rendering pipeline wants, and a small
          // shm has been observed to stall or crash a renderer under
          // constrained CI compute even when the exact same image runs fine
          // on a well-resourced local machine (see egress-broker-milestone.mjs
          // — passes reliably locally, fails on every recorded GitHub Actions
          // run). --disable-dev-shm-usage routes around that entirely by
          // using /tmp instead of /dev/shm. The other three flags stop
          // Chromium's own background telemetry/sync/update pings (visible in
          // CI logs as unrelated "navigate_allowed" lines for Google domains)
          // from competing for startup time and cluttering the egress
          // broker's log with noise unrelated to whatever the agent actually
          // navigated to.
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
        ],
      });
    })();
  }
  return browserPromise;
}

export async function getPage(): Promise<Page> {
  if (!pagePromise) {
    pagePromise = launchChromium().then((browser) => browser.newPage());
  }
  return pagePromise;
}
