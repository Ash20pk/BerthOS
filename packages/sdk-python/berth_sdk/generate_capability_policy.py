"""Mirrors @berthos/sdk's generate-capability-policy.ts exactly (same policy
shape, same deny-by-default network and read-path rules, same
per-app baseline write/read paths) — agent-init (Rust) reads whichever
one ran, TypeScript or Python, without caring which wrote it. Invoked as
`python3 -m berth_sdk.generate_capability_policy`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .manifest import load_manifest, parse_capability

# Per-app, not container-wide: this used to be all of /tmp for every app, which
# let one app reach another's RPC socket. See the TypeScript original for why a
# narrower Landlock policy is only half the fix (DAC is the other half) and for
# the socket layout these two directories belong to.
#
# /dev/null is the one entry that stays shared, and it is here rather than in
# TERMINAL_WRITE_PATHS because opening it read-write is what any process does
# when it redirects a child's stdio to it — see the TypeScript original for the
# strace this came from, and for why /dev/tty is deliberately absent
# 
def _baseline_write_paths(app_name: str) -> list[str]:
    return ["/dev/null", f"/tmp/{app_name}", f"/run/berth/{app_name}"]

# Added only for an app declaring terminal:* — the one thing that capability
# compiles into the kernel policy. Without it a tmux server cannot allocate a
# pty on a Landlock-enforcing kernel.
TERMINAL_WRITE_PATHS = ["/dev/pts", "/dev/ptmx"]

# Where github-api-broker.cjs writes the CA an app declaring github:* is told
# to trust. Read-granted only for such an app, and only because that CA moved
# out of /tmp (which the read baseline covers in full) into /run/berth —
# Kept in step with that script's own default.
GITHUB_BROKER_CERT_DIR = "/run/berth/github-api-broker"


# /tmp stays fully readable even though it is no longer fully writable: reads
# are not what 1.4 was about, and statting a daemon control socket before
# connecting to it needs them.
def _baseline_read_paths(app_name: str) -> list[str]:
    # /bin and /sbin are real directories on Alpine, not links into /usr, so
    # without them an app can't exec sh or anything busybox provides.
    return ["/usr", "/bin", "/sbin", "/lib", "/etc", "/proc", "/dev", "/tmp", f"/run/berth/{app_name}", str(Path.cwd())]


def _sdk_read_paths(pythonpath: str | None = None, app_dir: str | None = None) -> list[str]:
    """Where berth_sdk itself is loaded from (entrypoint.sh's PYTHONPATH):
    the image's /opt/berth/sdk-python, or the checkout's packages/sdk-python
    when the repo is bind-mounted. The runtime can't start without it once
    reads are scoped.

    PYTHONPATH is the boot environment's, which entrypoint.sh only prepends
    to, so an entry is not taken on trust: each is resolved, and kept only if
    it is an existing directory at least two levels deep that doesn't contain
    the app's own directory and isn't another app's (see _is_app_content).
    That drops "/", "/workspace" or "/app" (which would grant every other
    app's code), /app/apps/other or /workspace/examples/..., and anything that
    doesn't exist."""
    raw = os.environ.get("PYTHONPATH", "") if pythonpath is None else pythonpath
    app_real = os.path.realpath(app_dir if app_dir is not None else os.getcwd())
    out: list[str] = []
    for entry in raw.split(":"):
        if not entry or not os.path.isabs(entry):
            continue
        real = os.path.realpath(entry)
        too_broad = len(Path(real).parts) < 3 or app_real == real or app_real.startswith(real.rstrip("/") + "/")
        if too_broad or not os.path.isdir(real) or _is_app_content(real):
            print(
                f"[berth:capability-policy] WARNING: not granting read access to PYTHONPATH entry {entry!r} — it is missing, not a directory, too broad, or another app's directory"
            )
            continue
        if real not in out:
            out.append(real)
    return out


# How far below a PYTHONPATH entry to look for a berth.yml. The SDK's own
# directory holds none at any depth; a directory of apps (examples/,
# examples/resident-apps/) holds one within a level or two.
_APP_SCAN_DEPTH = 3
_APP_SCAN_SKIP = {"node_modules", "__pycache__"}


def _is_app_content(real: str) -> bool:
    """True if `real` is part of an app, or holds one: it is under an apps/
    directory, it or a directory above it has a berth.yml, or one of the
    directories within _APP_SCAN_DEPTH levels below it does. The SDK lives
    in packages/sdk-python or /opt/berth/sdk-python, none of which match."""
    path = Path(real)
    if "apps" in path.parts:
        return True
    if any((d / "berth.yml").is_file() for d in (path, *path.parents)):
        return True
    for current, dirs, files in os.walk(real):
        if "berth.yml" in files:
            return True
        depth = len(Path(current).relative_to(path).parts)
        # Pruned in place, so os.walk doesn't descend: not past the depth
        # limit, and not into dependency or hidden directories.
        dirs[:] = [] if depth + 1 >= _APP_SCAN_DEPTH else [d for d in dirs if d not in _APP_SCAN_SKIP and not d.startswith(".")]
    return False


def _strip_trailing_glob(scope: str) -> str:
    return scope[:-2] if scope.endswith("/*") else scope



def main() -> None:
    manifest_path = os.environ.get("BERTH_MANIFEST_PATH", str(Path.cwd() / "berth.yml"))
    policy_path = Path(os.environ.get("BERTH_CAPABILITY_POLICY", str(Path.cwd() / ".berth" / "capability-policy.json")))

    manifest = load_manifest(manifest_path)
    effective_capabilities = list(manifest.capabilities)

    write_paths = set(_baseline_write_paths(manifest.name))
    declared_read_paths: set[str] = set()
    network_ports: set[int] = set()
    network_unrestricted = False
    needs_github_broker_ca = False

    for capability in effective_capabilities:
        parsed = parse_capability(capability)
        if parsed.namespace == "filesystem" and parsed.action == "write":
            write_paths.add(_strip_trailing_glob(parsed.scope))
        elif parsed.namespace == "filesystem" and parsed.action == "read":
            declared_read_paths.add(_strip_trailing_glob(parsed.scope))
        elif parsed.namespace == "network" and parsed.action == "connect":
            if parsed.scope == "*":
                network_unrestricted = True
                continue
            try:
                port = int(parsed.scope)
            except ValueError:
                port = -1
            if 0 < port <= 65535:
                network_ports.add(port)
            else:
                print(f'[berth:capability-policy] WARNING: ignoring invalid network:connect scope "{parsed.scope}" (expected a port 1-65535, or "*")')
        elif parsed.namespace == "terminal":
            write_paths.update(TERMINAL_WRITE_PATHS)
        elif parsed.namespace == "github":
            needs_github_broker_ca = True

    # Always scoped, as in generate-capability-policy.ts: an app reads the
    # baseline, its own directory, the SDK, what it may write, and what it
    # declares. Reads used to be opt-in, which let an app with no read scope
    # read every other app's code and config in the sandbox.
    # Write paths the baseline already covers are left out: /dev/null and the
    # pty devices are files, and a read rule on a file leaves the ruleset
    # PartiallyEnforced.
    baseline = _baseline_read_paths(manifest.name)
    uncovered_writes = {p for p in write_paths if not any(p == b or p.startswith(b + "/") for b in baseline)}
    baseline_reads = set(baseline) | set(_sdk_read_paths()) | uncovered_writes
    if needs_github_broker_ca:
        baseline_reads.add(GITHUB_BROKER_CERT_DIR)
    read_paths = sorted(baseline_reads | declared_read_paths)

    policy = {
        "appName": manifest.name,
        "declaredCapabilities": effective_capabilities,
        "writePaths": sorted(write_paths),
        "readPaths": read_paths,
        "networkPorts": sorted(network_ports),
        "networkUnrestricted": network_unrestricted,
    }

    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(json.dumps(policy, indent=2))

    if network_unrestricted:
        network_summary = "networkPorts=* (unrestricted)"
    elif network_ports:
        network_summary = f"networkPorts={', '.join(str(p) for p in sorted(network_ports))}"
    else:
        network_summary = "networkPorts=(none — network denied by default)"
    read_summary = f"; readPaths={', '.join(read_paths)}" if read_paths else ""
    print(f"[berth:capability-policy] wrote {policy_path}: writePaths={', '.join(sorted(write_paths))}{read_summary}; {network_summary}")


if __name__ == "__main__":
    main()
