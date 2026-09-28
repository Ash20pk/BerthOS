import { access } from "node:fs/promises";
import { join } from "node:path";
import type { BerthManifest } from "@berthos/manifest-schema";

// The commands `berth test` runs inside an app's production image, by the
// app's `runtime:`. Split out of commands/test.ts so they can be tested
// without Docker.

/**
 * The image's own copy of berth_sdk, put on PYTHONPATH by hand: in a
 * multi-app container the check is a `docker exec`, which gets none of the
 * environment entrypoint.sh sets up for the app's process.
 */
const PYTHON_SDK_ENV = "PYTHONPATH=/opt/berth/sdk-python";

/** What checks an app's export contracts inside the image, by runtime. */
export function exportCheckCommand(runtime: BerthManifest["runtime"]): string[] {
  return runtime === "python"
    ? ["env", PYTHON_SDK_ENV, "python3", "-m", "berth_sdk.check_exports"]
    : ["node", "node_modules/@berthos/sdk/dist/check-exports.js"];
}

/**
 * A Python app's own test suite: pytest, when the app has a `tests/`
 * directory. pytest is not in the base image, so an app with tests installs
 * it the way it installs anything else, through `on_install` (for example
 * `pip install -r requirements.txt`). Null when there is nothing to run.
 */
export async function pythonAppTestCommand(appDir: string): Promise<string[] | null> {
  try {
    await access(join(appDir, "tests"));
  } catch {
    return null;
  }
  return ["env", PYTHON_SDK_ENV, "python3", "-m", "pytest", "-q", "tests"];
}
