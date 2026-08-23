# gVisor hardened-runtime probe — 2026-08-23

BUILD_PLAN M1.4's stated risk was gVisor's limited FUSE support fighting the
semantic-fs sidecar. The real blocker turned out to be one layer lower, and
the passthrough + doctor check caught it exactly as designed.

## Environment

- Host: macOS (Darwin 25.6.0, Apple silicon), Colima (vz, virtiofs)
- Guest: Ubuntu 24.04.4 LTS, kernel 6.8.0-117-generic, aarch64, Docker 29.5.2
- gVisor: `runsc release-20260817.0` (official release binaries,
  sha512-verified; `runsc install` registered the runtime, daemon.json backed
  up to `daemon.json.bak-pre-gvisor` in the VM)

## What was run, and what happened

1. `berth doctor --runtime runsc` — new `runtime` check reports `ok`
   (runtime registered, default stays `runc`); the Landlock probe, now run
   *under* the requested runtime, reports:

   > ✘ Landlock enforcement in the container kernel (runtime "runsc")
   >   the Landlock syscalls are not available in this kernel (Function not implemented)

   The same probe under the default runtime on the same host reports
   `enforcement: ACTIVE`. **gVisor's sentry does not implement Landlock**, so
   the answer is a property of the runtime, not the host kernel — which is why
   the probe and the boot-banner cache are now keyed per runtime.

2. `BERTH_RUNTIME=runsc node test/capability-enforcement.mjs` — the boot
   banner fires with the runtime-specific message, `agent-init` reports
   `ruleset=NotEnforced`, and the suite fails at Test 1: even the *declared*
   write inside `/workspace` returns `EACCES` through gVisor's gofer on this
   virtiofs-backed bind mount (a bare `docker run --runtime=runsc` shows plain
   root-owned DAC either way, so this second failure is about the boot path's
   ownership model meeting the gofer; not root-caused — moot while the
   Landlock gap stands).

3. The FUSE-sidecar interaction M1.4 flagged was therefore never reached.

## Verdict against the done-when

"Boot under gVisor passes `capability-enforcement.mjs` on a host that has it"
is **not achievable with current gVisor**: the suite's enforcement assertions
cannot pass on a kernel with no Landlock, and under gVisor the kernel is the
sentry. Shipped instead, per the milestone's actual intent: the `runtime:`
passthrough, a doctor `runtime` check plus per-runtime enforcement probe, and
docs that state the trade plainly (kernel-enforcement.md § Optional hardened
runtime). The check exists precisely so nobody discovers this in production:
selecting runsc today buys escape protection at the price of the entire
kernel enforcement tier, and both doctor and the boot banner say so.

Re-probe when gVisor gains Landlock — the probe is behavioural, so no code
change is needed for the answer to flip.
