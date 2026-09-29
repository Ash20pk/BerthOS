"""Mirrors @berthos/sdk's generate-capability-policy.ts exactly (same policy
shape, same deny-by-default network and read-path rules, same per-app
baseline write/read paths, same field order) — agent-init (Rust) reads
whichever one ran, TypeScript or Python, without caring which wrote it.
Invoked as `python3 -m berth_sdk.generate_capability_policy`.

tests/test_policy_parity.py compiles the same capability lists with both and
asserts the JSON is identical, so a change to one that isn't made to the other
fails CI rather than a Python app's boot.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Iterable, Mapping, Optional

from .manifest import capability_issue, is_capability_string, load_manifest, parse_capability

# Per-app, not container-wide: this used to be all of /tmp for every app, which
# let one app reach another's RPC socket. See the TypeScript original for why a
# narrower Landlock policy is only half the fix (DAC is the other half) and for
# the socket layout these two directories belong to.
#
# /dev/null is the one entry that stays shared, and it is here rather than in
# TERMINAL_WRITE_PATHS because opening it read-write is what any process does
# when it redirects a child's stdio to it — see the TypeScript original for the
# strace this came from, and for why /dev/tty is deliberately absent.
def _baseline_write_paths(app_name: str) -> list[str]:
    return ["/dev/null", f"/tmp/{app_name}", f"/run/berth/{app_name}"]


# Added only for an app declaring terminal:* — the one thing that capability
# compiles into the kernel policy. Without it a tmux server cannot allocate a
# pty on a Landlock-enforcing kernel.
TERMINAL_WRITE_PATHS = ["/dev/pts", "/dev/ptmx"]

# Where github-api-broker.cjs writes the CA an app declaring github:* is told
# to trust. Read-granted only for such an app, and only because that CA moved
# out of /tmp (which the read baseline covers in full) into /run/berth.
# Kept in step with that script's own default.
GITHUB_BROKER_CERT_DIR = "/run/berth/github-api-broker"

# The ttyd port apps/terminal serves on — container.ts's TERMINAL_PORT. An
# orchestration-level fact, like the HTTP RPC port, which is why neither is
# expressible as a capability. See computeBindPorts() in the TypeScript file.
TERMINAL_BIND_PORT = 7681


# /bin and /sbin are real directories on Alpine, not symlinks into /usr: leave
# them out and execve() of any busybox binary fails EACCES under an enforcing
# kernel for an app that declared a filesystem:read: capability. /tmp stays
# fully readable even though it is no longer fully writable: statting a daemon
# control socket before connecting to it needs it.
def _baseline_read_paths(app_name: str, cwd: str) -> list[str]:
    return ["/usr", "/bin", "/sbin", "/lib", "/etc", "/proc", "/dev", "/tmp", f"/run/berth/{app_name}", cwd]


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
            _warn(f"not granting read access to PYTHONPATH entry {entry!r} — it is missing, not a directory, too broad, or another app's directory")
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


def _port(scope: str) -> Optional[int]:
    """Number(scope) accepted as an integer 1-65535, the way the TypeScript
    compiler reads a port scope. Anything else is None."""
    text = scope.strip()
    if "_" in text:
        return None  # float() accepts digit separators; Number() does not
    try:
        value = float(text) if text else 0.0
    except ValueError:
        # Number() also reads 0x/0o/0b literals.
        if text[:2].lower() not in ("0x", "0o", "0b"):
            return None
        try:
            value = float(int(text, 0))
        except ValueError:
            return None
    if not value.is_integer() or not 0 < value <= 65535:
        return None
    return int(value)


def _warn(message: str) -> None:
    print(f"[berth:capability-policy] WARNING: {message}", file=sys.stderr)


def compile_capability_policy(
    app_name: str,
    raw_capabilities: Iterable[object],
    cwd: Optional[str] = None,
    mesh_coordinator_port: Optional[int] = None,
) -> dict:
    """compileCapabilityPolicy() in generate-capability-policy.ts — the pure
    namespace:action:scope -> policy compiler. It re-validates every string
    (grammar, then the filesystem-scope allowlist) rather than trusting its
    caller, and drops a bad one with a warning instead of failing: agent-init's
    fallback for "no policy file" is to run unrestricted, which is strictly
    worse than dropping one bad capability."""
    cwd = cwd if cwd is not None else os.getcwd()
    if mesh_coordinator_port is None:
        mesh_coordinator_port = int(os.environ.get("BERTH_MESH_COORDINATOR_PORT") or 4875)

    # dicts as insertion-ordered sets, so every list comes out in the order the
    # TypeScript compiler's Sets produce.
    effective: list[str] = []
    write_paths = dict.fromkeys(_baseline_write_paths(app_name))
    declared_read_paths: dict[str, None] = {}
    network_ports: dict[int, None] = {}
    mesh_peers: dict[str, None] = {}
    network_unrestricted = False
    declared_bind_ports: dict[int, None] = {}
    needs_github_broker_ca = False

    for capability in raw_capabilities:
        if not is_capability_string(capability):
            _warn(f"ignoring malformed capability string {json.dumps(capability, ensure_ascii=False, default=str)} (capability must be 'namespace:action:scope')")
            continue
        assert isinstance(capability, str)
        try:
            parsed = parse_capability(capability)
        except ValueError as err:
            _warn(f"ignoring capability string {json.dumps(capability, ensure_ascii=False)} that failed to parse ({err})")
            continue

        # Every path in this policy is one that is created as root before
        # enforcement, so the allowlist is re-checked here for any input.
        issue = capability_issue(capability)
        if issue:
            _warn(f"ignoring capability {json.dumps(capability, ensure_ascii=False)} — {issue}")
            continue

        effective.append(capability)
        ns, action, scope = parsed.namespace, parsed.action, parsed.scope
        if ns == "filesystem" and action == "write":
            write_paths[_strip_trailing_glob(scope)] = None
        elif ns == "filesystem" and action == "read":
            declared_read_paths[_strip_trailing_glob(scope)] = None
        elif ns == "network" and action == "connect":
            if scope == "*":
                network_unrestricted = True
                continue
            port = _port(scope)
            if port is not None:
                network_ports[port] = None
            else:
                _warn(f'ignoring invalid network:connect scope "{scope}" (expected a port 1-65535, or "*")')
        elif ns == "network" and action == "bind":
            bind_port = _port(scope)
            if bind_port is not None:
                declared_bind_ports[bind_port] = None
            else:
                _warn(f'ignoring invalid network:bind scope "{scope}" (expected a port 1-65535; "*" is deliberately not accepted — name the port you listen on)')
        elif ns == "network" and action == "peer":
            mesh_peers[scope] = None
            network_ports[mesh_coordinator_port] = None
        elif ns == "terminal":
            for path in TERMINAL_WRITE_PATHS:
                write_paths[path] = None
        elif ns == "github":
            needs_github_broker_ca = True

    # Always scoped, as in generate-capability-policy.ts: an app reads the
    # baseline, the SDK (where the TypeScript compiler grants its
    # dependencies' real locations), what it may write, and what it declares.
    # Reads used to be opt-in, which let an app with no read scope read every
    # other app's code and config in the sandbox. Write paths the baseline
    # already covers are left out: /dev/null and the pty devices are files,
    # and a read rule on a file leaves the ruleset PartiallyEnforced.
    baseline = _baseline_read_paths(app_name, cwd)

    def covered(path: str) -> bool:
        return any(path == b or path.startswith(b + "/") for b in baseline)

    read_paths = list(
        dict.fromkeys(
            [
                *baseline,
                *_sdk_read_paths(app_dir=cwd),
                *[path for path in write_paths if not covered(path)],
                *([GITHUB_BROKER_CERT_DIR] if needs_github_broker_ca else []),
                *declared_read_paths,
            ]
        )
    )

    return {
        "appName": app_name,
        "declaredCapabilities": effective,
        "writePaths": list(write_paths),
        "readPaths": read_paths,
        "networkPorts": list(network_ports),
        "networkUnrestricted": network_unrestricted,
        "meshPeers": list(mesh_peers),
        "bindPorts": list(declared_bind_ports),
    }


def compute_bind_ports(app_name: str, env: Mapping[str, str], capabilities: Iterable[str] = ()) -> list[int]:
    """computeBindPorts() in the TypeScript file: the orchestration-level
    ports an app may bind() — the HTTP RPC bridge's, for the one app it is
    bound to, and ttyd's for a terminal:* app."""
    ports: list[int] = []
    raw = env.get("BERTH_HTTP_RPC_PORT")
    http_rpc_port = _port(raw) if raw else None
    bound_app = env.get("BERTH_HTTP_RPC_APP")
    if http_rpc_port and (not bound_app or bound_app == app_name):
        ports.append(http_rpc_port)
    if any(cap.startswith("terminal:") for cap in capabilities):
        ports.append(TERMINAL_BIND_PORT)
    return list(dict.fromkeys(ports))


def http_rpc_tls_read_paths(app_name: str, env: Mapping[str, str]) -> list[str]:
    """httpRpcTlsReadPaths() in the TypeScript file: the directories holding
    the HTTP RPC bridge's TLS certificate and key, for the one app that serves
    the bridge (gated as compute_bind_ports is). The directory, not the file,
    since a read rule on a file leaves the ruleset PartiallyEnforced; the path
    as given and its real location both count, and "/" and relative paths are
    never granted."""
    bound_app = env.get("BERTH_HTTP_RPC_APP")
    if not env.get("BERTH_HTTP_RPC_PORT") or (bound_app and bound_app != app_name):
        return []
    dirs: list[str] = []
    for file in (env.get("BERTH_HTTP_RPC_TLS_CERT"), env.get("BERTH_HTTP_RPC_TLS_KEY")):
        if not file or not os.path.isabs(file):
            continue
        try:
            real: Optional[str] = str(Path(file).resolve(strict=True))
        except OSError:
            real = None
        for path in (file, real):
            # path.dirname() ignores trailing slashes; os.path.dirname does not.
            directory = os.path.dirname(path.rstrip("/") or "/") if path else None
            if directory and directory != "/":
                dirs.append(directory)
    return list(dict.fromkeys(dirs))


def main() -> None:
    manifest_path = os.environ.get("BERTH_MANIFEST_PATH", str(Path.cwd() / "berth.yml"))
    policy_path = Path(os.environ.get("BERTH_CAPABILITY_POLICY", str(Path.cwd() / ".berth" / "capability-policy.json")))

    manifest = load_manifest(manifest_path)
    policy = compile_capability_policy(manifest.name, manifest.capabilities)
    # Union, not overwrite, as in the TypeScript main().
    policy["bindPorts"] = list(
        dict.fromkeys([*policy["bindPorts"], *compute_bind_ports(manifest.name, os.environ, manifest.capabilities)])
    )
    granted = list(policy["readPaths"])
    policy["readPaths"].extend(
        d for d in http_rpc_tls_read_paths(manifest.name, os.environ) if not any(d == g or d.startswith(g + "/") for g in granted)
    )

    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(json.dumps(policy, indent=2))

    if policy["networkUnrestricted"]:
        network_summary = "networkPorts=* (unrestricted)"
    elif policy["networkPorts"]:
        network_summary = f"networkPorts={', '.join(str(p) for p in policy['networkPorts'])}"
    else:
        network_summary = "networkPorts=(none — network denied by default)"
    print(
        f"[berth:capability-policy] wrote {policy_path}: writePaths={', '.join(policy['writePaths'])}"
        + (f"; readPaths={', '.join(policy['readPaths'])}" if policy["readPaths"] else "")
        + f"; {network_summary}"
        + (f"; bindPorts={', '.join(str(p) for p in policy['bindPorts'])}" if policy["bindPorts"] else "")
        + (f"; meshPeers={', '.join(policy['meshPeers'])}" if policy["meshPeers"] else ""),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
