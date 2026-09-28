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

from berth_sdk.generate_capability_policy import compile_capability_policy, compute_bind_ports

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_COMPILER = REPO_ROOT / "packages" / "sdk" / "dist" / "generate-capability-policy.js"
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "policy-parity.json").read_text())
CONFORMANCE = REPO_ROOT / "spec" / "capability-manifest" / "conformance" / "cases.json"

_NODE_DRIVER = """
const { compileCapabilityPolicy, computeBindPorts } = await import(process.argv[1]);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { policies, bindPorts } = JSON.parse(input);
process.stdout.write(JSON.stringify({
  policies: policies.map((c) => compileCapabilityPolicy(c.appName, c.capabilities)),
  bindPorts: bindPorts.map((c) => computeBindPorts(c.appName, c.env, c.capabilities)),
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


def _typescript(policies: list[dict], bind_ports: list[dict], cwd: Path) -> dict:
    node = shutil.which("node")
    if node is None or not TS_COMPILER.exists():
        if os.environ.get("BERTH_POLICY_PARITY_REQUIRED") == "1":
            pytest.fail(f"parity test required but node or {TS_COMPILER} is missing (run pnpm build)")
        pytest.skip("node or the built @berthos/sdk is not available")
    env = {k: v for k, v in os.environ.items() if k != "BERTH_MESH_COORDINATOR_PORT"}
    completed = subprocess.run(
        [node, "--input-type=module", "-e", _NODE_DRIVER, TS_COMPILER.as_uri()],
        input=json.dumps({"policies": policies, "bindPorts": bind_ports}),
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        check=True,
    )
    return json.loads(completed.stdout)


def test_both_compilers_produce_the_same_policy(short_tmp, clean_env):
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
