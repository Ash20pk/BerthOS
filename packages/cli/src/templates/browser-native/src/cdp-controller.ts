import { chromium, type Browser, type Page } from "playwright-core";
import { waitForDisplay } from "./vnc.js";

let browserPromise: Promise<Browser> | undefined;
let pagePromise: Promise<Page> | undefined;

/**
 * Launches the system Chromium (via CHROME_BIN, not Playwright's bundled
 * download). Visible (headless: false) against Xvfb so a human can watch it
 * over VNC; headless in BERTH_TEST_MODE so `berth test` doesn't need a display.
 */
export function launchChromium(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      await waitForDisplay();
      return chromium.launch({
        executablePath: process.env.CHROME_BIN,
        headless: process.env.BERTH_TEST_MODE === "1",
        args: ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--no-sandbox"],
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
