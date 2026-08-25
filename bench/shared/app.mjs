// The Berth-side wrapper around bench/probe/probe.mjs.
//
// It exists so the benchmark's agent-side actions run where they have to run
// to mean anything under Berth: inside the app's OWN process, the one
// agent-init applied the Landlock domain, the seccomp filter and the uid drop
// to before exec'ing it. A `docker exec` into the same container would not be
// a descendant of that process — Landlock binds a process and its future
// children — so probing that way would report escapes no agent could actually
// perform.
//
// `defineApp` and `zod` are passed in rather than imported here: this file
// lives outside any package, and Node resolves a bare specifier by walking up
// from the importing file, which from bench/shared reaches no node_modules
// holding @berth/sdk. The fixtures own the imports; this file owns the logic,
// so bench-probe-a and bench-probe-b cannot drift apart in what they probe.
import { runCheck, runAll } from "../probe/probe.mjs";

export function createProbeApp({ defineApp, z }) {
  return defineApp((app) => {
    app.export({
      name: "run_probe",
      input: z.object({ check: z.string().optional() }),
      // A JSON string rather than a typed object: the probe's result shape is
      // owned by probe.mjs, and restating it in a zod schema here would be a
      // second definition to drift.
      output: z.object({ json: z.string() }),
      handler: async ({ check }) => ({ json: JSON.stringify(check ? { [check]: await runCheck(check) } : await runAll()) }),
    });
  });
}
