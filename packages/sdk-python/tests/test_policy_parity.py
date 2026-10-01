"""The Python policy compiler against the TypeScript one, on the same inputs.

agent-init reads whichever compiler ran, so a Python app's kernel policy is
only as right as its agreement with generate-capability-policy.ts. This runs
the real compiled TypeScript (packages/sdk/dist, from `pnpm build`) and the
Python module over a fixture corpus plus every manifest in the capability
conformance corpus, and asserts byte-identical JSON.

Skipped when node or the built SDK is missing, unless
BERTH_POLICY_PARITY_REQUIRED=1 (CI sets it), in which case that is a failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from berth_sdk.generate_capability_policy import (
    compile_capability_policy,
    compile_cgroup_limits,
    compute_bind_ports,
    http_rpc_tls_read_paths,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_COMPILER = REPO_ROOT / "packages" / "sdk" / "dist" / "generate-capability-policy.js"
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "policy-parity.json").read_text())
CONFORMANCE = REPO_ROOT / "spec" / "capability-manifest" / "conformance" / "cases.json"

_NODE_DRIVER = """
const { compileCapabilityPolicy, compileCgroupLimits, computeBindPorts, httpRpcTlsReadPaths } = await import(process.argv[1]);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { policies, bindPorts, tlsReadPaths = [], cgroupLimits = [] } = JSON.parse(input);
process.stdout.write(JSON.stringify({
  policies: policies.map((c) => compileCapabilityPolicy(c.appName, c.capabilities)),
  bindPorts: bindPorts.map((c) => computeBindPorts(c.appName, c.env, c.capabilities)),
  tlsReadPaths: tlsReadPaths.map((c) => httpRpcTlsReadPaths(c.appName, c.env)),
  cgroupLimits: cgroupLimits.map((r) => compileCgroupLimits(r)),
}));
"""


def _policy_cases() -> list[dict]:
    cases = list(FIXTURES["cases"])
    for case in json.loads(CONFORMANCE.read_text())["cases"]:
        manifest = case.get("manifest")
        if not isinstance(manifest, dict) or not isinstance(manifest.get("capabilities"), list):
            continue
        name = manifest.get("name")
        cases.append({"appName": name if isinstance(name, str) else "app", "capabilities": manifest["capabilities"], "id": case["id"]})
    return cases


def _typescript(
    policies: list[dict], bind_ports: list[dict], cwd: Path, tls_read_paths: list[dict] = (), cgroup_limits: list[dict] = ()
) -> dict:
    node = shutil.which("node")
    if node is None or not TS_COMPILER.exists():
        if os.environ.get("BERTH_POLICY_PARITY_REQUIRED") == "1":
            pytest.fail(f"parity test required but node or {TS_COMPILER} is missing (run pnpm build)")
        pytest.skip("node or the built @berthos/sdk is not available")
    env = {k: v for k, v in os.environ.items() if k != "BERTH_MESH_COORDINATOR_PORT"}
    completed = subprocess.run(
        [node, "--input-type=module", "-e", _NODE_DRIVER, TS_COMPILER.as_uri()],
        input=json.dumps(
            {"policies": policies, "bindPorts": bind_ports, "tlsReadPaths": list(tls_read_paths), "cgroupLimits": list(cgroup_limits)}
        ),
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        check=True,
    )
    return json.loads(completed.stdout)


def test_both_compilers_produce_the_same_policy(short_tmp, clean_env):
    # The SDK's PYTHONPATH entry is the Python side's counterpart of the
    # dependency paths TypeScript finds under the app's node_modules; cwd is
    # an empty directory here, so neither side has any.
    clean_env.delenv("PYTHONPATH", raising=False)
    policies = _policy_cases()
    bind_ports = FIXTURES["bindPortCases"]
    # process.cwd() is the resolved path (/tmp is a symlink on macOS).
    cwd = short_tmp.resolve()
    expected = _typescript(policies, bind_ports, cwd)

    for case, want in zip(policies, expected["policies"]):
        got = compile_capability_policy(case["appName"], case["capabilities"], cwd=str(cwd))
        # Byte-identical, key order included: JSON.stringify's output is what
        # agent-init parses, and the Python writer must produce the same file.
        assert json.dumps(got) == json.dumps(want, ensure_ascii=True), f"policy differs for {case.get('id', case['appName'])}"

    for case, want in zip(bind_ports, expected["bindPorts"]):
        assert compute_bind_ports(case["appName"], case["env"], case["capabilities"]) == want, case


def test_the_corpus_is_not_empty():
    # A parity test over nothing passes trivially.
    assert len(_policy_cases()) > len(FIXTURES["cases"])


def test_both_compilers_grant_the_same_tls_directories(short_tmp, clean_env):
    root = short_tmp.resolve()
    secret = root / "secret"
    secret.mkdir()
    (secret / "tls.crt").write_text("cert")
    (root / "mounted").symlink_to(secret)
    port = {"BERTH_HTTP_RPC_PORT": "7443"}
    cases = [
        {"appName": "a", "env": {**port, "BERTH_HTTP_RPC_TLS_CERT": str(root / "mounted" / "tls.crt"), "BERTH_HTTP_RPC_TLS_KEY": "/tls.key"}},
        {"appName": "a", "env": {**port, "BERTH_HTTP_RPC_APP": "a", "BERTH_HTTP_RPC_TLS_CERT": str(root / "missing" / "c.pem"), "BERTH_HTTP_RPC_TLS_KEY": "rel/k.pem"}},
        {"appName": "a", "env": {**port, "BERTH_HTTP_RPC_APP": "b", "BERTH_HTTP_RPC_TLS_CERT": str(secret / "tls.crt")}},
        {"appName": "a", "env": {"BERTH_HTTP_RPC_TLS_CERT": str(secret / "tls.crt")}},
    ]
    expected = _typescript([], [], root, cases)["tlsReadPaths"]
    assert expected[0] == [str(root / "mounted"), str(secret)]
    for case, want in zip(cases, expected):
        assert http_rpc_tls_read_paths(case["appName"], case["env"]) == want, case


def test_both_compilers_write_the_same_cgroup_limits(short_tmp, clean_env):
    # The limits land in the same policy file, so they are held to the same
    # byte-for-byte standard — including the rounding of a fractional cpu,
    # which is where a float formatted differently would show.
    cases = FIXTURES["cgroupLimitCases"]
    expected = _typescript([], [], short_tmp.resolve(), cgroup_limits=cases)["cgroupLimits"]
    assert len(expected) == len(cases)
    for case, want in zip(cases, expected):
        assert json.dumps(compile_cgroup_limits(case)) == json.dumps(want), case
