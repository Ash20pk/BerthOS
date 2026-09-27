"""Mirrors @berthos/sdk's generate-capability-policy.ts exactly (same policy
shape, same deny-by-default network/opt-in read-path rules, same
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
    return ["/usr", "/lib", "/etc", "/proc", "/dev", "/tmp", f"/run/berth/{app_name}", str(Path.cwd())]


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

    baseline_reads = set(_baseline_read_paths(manifest.name))
    if needs_github_broker_ca:
        baseline_reads.add(GITHUB_BROKER_CERT_DIR)
    read_paths = sorted(baseline_reads | declared_read_paths) if declared_read_paths else []

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
