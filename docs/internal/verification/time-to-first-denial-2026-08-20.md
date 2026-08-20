# Time-to-first-denial — measured 2026-08-20

Host: maintainer's macOS (Apple Silicon), Colima VM already provisioned
(Ubuntu 24.04.4, kernel 6.8.0-117, Landlock ABI 4), Berth images cached.
Flow exercised exactly as a user would run it, from a shell with
`DOCKER_HOST` unset (i.e. pointing at Docker Desktop):

| Step | Command | Wall clock |
|---|---|---|
| 1 | `berth doctor --fix` — reports Docker Desktop `NOT ACTIVE`, re-checks against the Colima socket, reports `enforcement: ACTIVE`, prints the export line | 5.2 s |
| 2 | `export DOCKER_HOST=...` (printed by step 1) | — |
| 3 | `examples/kernel-says-no` → `EACCES` from the kernel on the undeclared write | 2 m 14 s |

**Total: ≈ 2 m 20 s — under the 3-minute bar.**

Honest caveats, per BUILD_PLAN rule 5:
- The Colima VM was already provisioned. A truly clean Mac pays
  `brew install colima docker` + `colima start` first (≈2–4 min, network
  dependent) — `--fix` performs both, but the sub-3-minute number above does
  not include them.
- Berth images were in the daemon's cache; a first `berth dev`/example run
  builds them. The 2 m 14 s is dominated by the example's container boot,
  not by image builds.
- The npm-published flow (`npm i -g @berth/cli`) is not yet measurable —
  packages are unpublished (M0.2 human gate). Re-measure on a clean machine
  after publish and update this file.
