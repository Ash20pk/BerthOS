import pytest
from pydantic import ValidationError

from berth_sdk.manifest import BerthManifest, app_cgroup_limits, capability_issue, is_capability_string


def test_a_filesystem_scope_outside_the_allowlist_is_rejected_on_load():
    with pytest.raises(ValidationError, match="must be /workspace, /context, /tmp, /app"):
        BerthManifest.model_validate({"name": "a", "version": "1.0.0", "capabilities": ["filesystem:write:/etc"]})


@pytest.mark.parametrize(
    "capability",
    ["filesystem:write:/", "filesystem:write:*", "filesystem:read:/workspace/../etc", "filesystem:write:/workspace/", "filesystem:write:/app/a*b"],
)
def test_capability_issue_matches_the_typescript_allowlist(capability):
    assert capability_issue(capability)


@pytest.mark.parametrize(
    "capability",
    [
        "filesystem:write:/app/apps/x/node_modules/@berthos/sdk/dist/node_modules",
        "filesystem:write:/app/node_modules",
        "filesystem:write:/workspace/node_modules/*",
    ],
)
def test_a_write_grant_inside_node_modules_is_refused(capability):
    assert "may not name a path inside node_modules" in (capability_issue(capability) or "")


def test_a_read_grant_inside_node_modules_is_not():
    assert capability_issue("filesystem:read:/app/node_modules") is None
    assert capability_issue("filesystem:write:/workspace/node_modules_backup") is None


def test_allowed_scopes_and_other_namespaces_have_no_issue():
    for capability in ["filesystem:write:/workspace", "filesystem:read:/context/*", "github:read:repos", "network:bind:*"]:
        assert capability_issue(capability) is None


def test_the_grammar_does_not_accept_a_trailing_newline():
    # Python's `$` matches before a final newline; JavaScript's does not.
    assert is_capability_string("github:read:repos")
    assert not is_capability_string("github:read:repos\n")


def test_resources_are_validated_as_the_typescript_schema_does():
    ok = BerthManifest.model_validate({"name": "a", "version": "1.0.0", "resources": {"cpu": 0.5, "memory_mb": 256, "gpu": 1, "pids": 64}})
    assert (ok.resources.cpu, ok.resources.memory_mb, ok.resources.gpu, ok.resources.pids) == (0.5, 256, 1, 64)
    assert BerthManifest.model_validate({"name": "a", "version": "1.0.0"}).resources.pids is None


@pytest.mark.parametrize(
    "resources",
    [{"cpu": 0}, {"cpu": "0.5"}, {"cpu": True}, {"memory_mb": 1.5}, {"memory_mb": -1}, {"gpu": 1.5}, {"pids": 0}, {"pids": 1.5}, {"pids": "64"}],
)
def test_invalid_resources_are_refused(resources):
    with pytest.raises(ValidationError):
        BerthManifest.model_validate({"name": "a", "version": "1.0.0", "resources": resources})


def test_memory_is_a_hard_limit_with_no_memory_high():
    # Past memory.high an app with no swap is throttled indefinitely instead of
    # being OOM-killed, so the compiler writes memory.max only.
    resources = BerthManifest.model_validate({"name": "a", "version": "1.0.0", "resources": {"memory_mb": 64}}).resources
    limits = app_cgroup_limits(resources)
    assert limits["memory.max"] == str(64 * 1024 * 1024)
    assert limits["memory.swap.max"] == "0"
    assert "memory.high" not in limits
