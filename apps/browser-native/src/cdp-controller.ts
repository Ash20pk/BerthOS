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
          // No --remote-debugging-address: Chromium's default is the
          // container's loopback interface, and that is the point. An
          // unauthenticated CDP endpoint is not a debugging convenience, it's
          // arbitrary local-file read (Page.navigate("file:///etc/passwd"))
          // and a total bypass of the egress broker
          // (Browser.setDownloadBehavior, Fetch.continueRequest) — every
          // capability this app's berth.yml carefully scopes. Binding it to
          // 0.0.0.0 handed that to anything that could open a TCP connection
          // to the container: the LAN (Docker published it on every host
          // interface), any sibling container on the same Docker network, and
          // any other app in this one. Playwright connects over loopback from
          // inside the container, so nothing legitimate needed the wider bind.
          "--remote-debugging-port=9222",
          // Chromium refuses its own sandbox as uid 0, and every process in a
          // Berth container is uid 0 today. A distinct per-app uid (REMEDIATION
          // 1.4/1.11) is necessary to lift this but is not sufficient, and an
          // earlier version of this comment was wrong to imply it would be
          // enough on its own: Chromium's namespace sandbox calls
          // clone(CLONE_NEWUSER|CLONE_NEWPID), which agent-init's seccomp
          // filter refuses for every app unconditionally and deliberately
          // (REMEDIATION 1.3). Enabling one means punching a hole in the
          // other, for the app with the largest remote attack surface — the
          // wrong app to make the exception for. See
          // docs/per-app-uid-design.md § Blocker 5. So this stays, and the
          // loopback bind above is what limits the blast radius: a renderer
          // exploit here lands as root in the container.
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
