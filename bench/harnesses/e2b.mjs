// Harness adapter: E2B, a hosted agent sandbox.
//
// Status, stated plainly because the benchmark mocks nothing: this
// adapter has **never been executed against the real service**. Running it
// needs an E2B account and an API key, which is a human gate — no agent can
// sign up. Until someone runs it with a key, the E2B column of every
// generated table reads NOT RUN, and that is the honest result rather than an
// empty column implying anything about E2B's containment.
//
// The adapter is written against E2B's documented SDK surface
// (`@e2b/code-interpreter`: `Sandbox.create()`, `files.write()`,
// `commands.run()`, `kill()`), loaded dynamically so the benchmark's other
// columns never depend on it being installed. If the SDK's API has moved, the
// run fails loudly with what it tried — a wrong result here would be worse
// than no result.
//
//   npm i @e2b/code-interpreter && E2B_API_KEY=… node bench/run.mjs --harness e2b
//
// Note what the hosted model changes about the rows: one workload per sandbox
// means the co-tenancy rows have no surface to test and are reported
// not-applicable, not passed. The host-reach row also measures something
// different in kind — the "host" there is E2B's infrastructure, not your
// laptop — so it is reported with that caveat attached rather than compared
// like-for-like.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_REMOTE_PATH = "/home/user/probe.mjs";

export const harness = {
  id: "e2b",
  title: "E2B (hosted sandbox)",
  description: "E2B's hosted sandbox via @e2b/code-interpreter. Requires E2B_API_KEY; never yet run against the live service.",

  /** Reports why it cannot run, rather than failing the whole benchmark. */
  unavailableReason() {
    if (!process.env.E2B_API_KEY) return "E2B_API_KEY is not set — sign-up is a human gate, so this column is NOT RUN";
    return undefined;
  },

  async run({ probeDir, hostEndpoint, secretValue, log }) {
    let Sandbox;
    try {
      ({ Sandbox } = await import("@e2b/code-interpreter"));
    } catch {
      throw new Error("@e2b/code-interpreter is not installed — `npm i @e2b/code-interpreter` to run this column (it is deliberately not a dependency of the repo)");
    }

    log("creating an E2B sandbox");
    const sandbox = await Sandbox.create();
    try {
      const probeSource = readFileSync(join(probeDir, "probe.mjs"), "utf-8");
      await sandbox.files.write(PROBE_REMOTE_PATH, probeSource);

      // Same env contract as every other harness. No sibling variables are
      // set: one workload per sandbox means there is no co-tenant to reach,
      // and the probe reports those rows unmeasured, which the scorer turns
      // into not-applicable for this harness.
      const env = {
        BENCH_DATA_DIR: "/home/user",
        BENCH_WORKLOAD_SECRET: secretValue,
        ...(hostEndpoint ? { BENCH_HOST_ENDPOINT: hostEndpoint } : {}),
      };
      const envPrefix = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");

      log("running the probe");
      const execution = await sandbox.commands.run(`${envPrefix} node ${PROBE_REMOTE_PATH} --all`, { timeoutMs: 180000 });
      const stdout = execution.stdout ?? "";
      let probeResults;
      try {
        probeResults = JSON.parse(stdout.trim().split("\n").pop());
      } catch (err) {
        throw new Error(`could not parse probe output (${err.message}): ${stdout}${execution.stderr ?? ""}`);
      }

      return {
        probeResults,
        // Nothing equivalent to `docker inspect` is exposed to a customer, so
        // these rows are reported as unavailable rather than guessed at.
        observations: {
          "secret-in-metadata": {
            outcome: "not-applicable",
            detail: "E2B exposes no customer-visible sandbox metadata API equivalent to `docker inspect`; this row cannot be measured from outside",
          },
          "published-port-exposure": {
            outcome: "not-applicable",
            detail: "port exposure is E2B's to configure, not the workload's; no ports were requested for this run",
          },
        },
        meta: { sandboxId: sandbox.sandboxId, note: "one workload per sandbox — the co-tenancy rows have no surface here" },
      };
    } finally {
      await sandbox.kill().catch(() => {});
    }
  },
};
