// The break-out box's target app.
//
// Its entire job is to do the thing every other part of Berth is built to
// survive: take code from a stranger and run it, in-process, with no
// validation whatsoever. There is deliberately no sanitising, no allowlist and
// no sandbox-within-the-sandbox here — if an attempt is refused, it must be
// refused by the kernel policy agent-init applied to this process before it
// started, or the box proves nothing about Berth.
//
// It runs in-process on purpose. A child process would still inherit the
// Landlock domain and seccomp filter, so spawning would be honest too — but
// in-process removes any doubt that the attacker's code is running exactly
// where the app's own code runs, with exactly the app's own privileges.
import { defineApp } from "@berth/sdk";
import { z } from "zod";

const ATTEMPT_TIMEOUT_MS = Number(process.env.BREAKOUT_ATTEMPT_TIMEOUT_MS ?? 10000);

/** Everything the attempt returned or threw, flattened to strings for the log. */
function describe(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

export default defineApp((app) => {
  app.export({
    name: "attempt",
    input: z.object({ code: z.string() }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
    handler: async ({ code }) => {
      // An async function body, so submissions can await. `new Function`
      // rather than `eval` only so the body has its own scope — it is not a
      // security measure and is not claimed as one.
      let run;
      try {
        run = new Function("require", `return (async () => { ${code} })()`);
      } catch (err) {
        return { ok: false, output: `submission did not parse: ${describe(err?.message ?? err)}` };
      }

      // node:* modules by specifier, so an attempt can reach the filesystem
      // and network APIs directly. This is the attacker's toolkit, handed
      // over deliberately.
      const require = (specifier) => import(specifier);

      let timer;
      try {
        const result = await Promise.race([
          run(require),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`attempt exceeded ${ATTEMPT_TIMEOUT_MS}ms`)), ATTEMPT_TIMEOUT_MS);
          }),
        ]);
        return { ok: true, output: describe(result) };
      } catch (err) {
        // A refusal is a result, not a failure: EACCES from the kernel is the
        // box working. The text is returned verbatim so a challenger can see
        // exactly which syscall said no.
        return { ok: false, output: describe(err?.stack ?? err?.message ?? err) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
});
