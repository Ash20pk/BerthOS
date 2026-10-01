"""Mirrors @berthos/manifest-schema's schema.ts/capability.ts — the manifest
shape and capability-string grammar are plain data (YAML + a
namespace:action:scope string), not TypeScript-specific, so a Python
implementation validates the exact same shape rather than porting any code.
"""

from __future__ import annotations

import json
import math
import re
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, Field, field_validator

CAPABILITY_RE = re.compile(r"^[a-z0-9_-]+:[a-z0-9_-]+:.+$")
NAME_RE = re.compile(r"^[a-z0-9-]+$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

JsonPrimitiveType = Literal["string", "number", "boolean", "object", "array"]


class ExportSpec(BaseModel):
    name: str
    input: dict[str, JsonPrimitiveType] = Field(default_factory=dict)
    output: dict[str, JsonPrimitiveType] = Field(default_factory=dict)


def _positive_number(value: object, *, integer: bool) -> object:
    """z.number().positive() (and .int()) in schema.ts. Strict about type as
    zod is: a bool or a numeric string is refused, not coerced."""
    if value is None:
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("must be a number")
    if integer and not float(value).is_integer():
        raise ValueError("must be an integer")
    if value <= 0:
        raise ValueError("must be positive")
    return int(value) if integer else value


class ResourcesSpec(BaseModel):
    """ResourcesSpec in schema.ts. What each key means for an app's cgroup is
    app_cgroup_limits() below."""

    cpu: Optional[float] = None
    memory_mb: Optional[int] = None
    gpu: Optional[int] = None
    pids: Optional[int] = None

    @field_validator("cpu", mode="before")
    @classmethod
    def _validate_cpu(cls, v: object) -> object:
        return _positive_number(v, integer=False)

    @field_validator("memory_mb", "gpu", "pids", mode="before")
    @classmethod
    def _validate_count(cls, v: object) -> object:
        return _positive_number(v, integer=True)


class BerthManifest(BaseModel):
    name: str
    version: str
    description: str = ""
    capabilities: list[str] = Field(default_factory=list)
    exports: list[ExportSpec] = Field(default_factory=list)
    on_install: list[str] = Field(default_factory=list)
    on_agent_ready: list[str] = Field(default_factory=list)
    resources: ResourcesSpec = Field(default_factory=ResourcesSpec)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not NAME_RE.match(v):
            raise ValueError("name must be lowercase alphanumeric with dashes")
        return v

    @field_validator("version")
    @classmethod
    def _validate_version(cls, v: str) -> str:
        if not VERSION_RE.match(v):
            raise ValueError("version must be semver (x.y.z)")
        return v

    @field_validator("capabilities")
    @classmethod
    def _validate_capabilities(cls, v: list[str]) -> list[str]:
        for cap in v:
            if not is_capability_string(cap):
                raise ValueError(f"capability must be 'namespace:action:scope', got {cap!r}")
            # The same semantic check BerthManifestSchema's superRefine makes:
            # a filesystem: scope becomes a real path created as root.
            issue = capability_issue(cap)
            if issue:
                raise ValueError(f"capability {cap!r}: {issue}")
        return v


def is_capability_string(capability: object) -> bool:
    """CapabilityString in schema.ts. fullmatch rather than match: Python's
    `$` also matches before a trailing newline, which JavaScript's does not."""
    return isinstance(capability, str) and CAPABILITY_RE.fullmatch(capability) is not None


def load_manifest(path: str) -> BerthManifest:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return BerthManifest.model_validate(raw)


class ParsedCapability:
    __slots__ = ("namespace", "action", "scope")

    def __init__(self, namespace: str, action: str, scope: str) -> None:
        self.namespace = namespace
        self.action = action
        self.scope = scope


def parse_capability(capability: str) -> ParsedCapability:
    parts = capability.split(":")
    if len(parts) < 3:
        raise ValueError(f'invalid capability string "{capability}": expected \'namespace:action:scope\'')
    namespace, action, *scope_parts = parts
    return ParsedCapability(namespace, action, ":".join(scope_parts))


def _glob_to_regex(glob: str) -> re.Pattern[str]:
    escaped = re.escape(glob).replace(r"\*", ".*")
    return re.compile(f"^{escaped}$")


def matches_capability(granted: str, requested: str) -> bool:
    g = parse_capability(granted)
    r = parse_capability(requested)
    if g.namespace != r.namespace or g.action != r.action:
        return False
    return bool(_glob_to_regex(g.scope).match(r.scope))


# Mirrors ALLOWED_FILESYSTEM_SCOPE_PREFIXES in @berthos/manifest-schema's
# capability.ts — the only path prefixes a filesystem:read:/filesystem:write:
# capability may name. Every declared write path is created as root before
# enforcement (precreate_declared_paths in entrypoint.sh, and agent-init), so
# an unconstrained scope would let a manifest create and be granted any path
# in the container. Keep the two lists identical; agent-init re-checks its
# own copy in Rust.
ALLOWED_FILESYSTEM_SCOPE_PREFIXES = ["/workspace", "/context", "/tmp", "/app"]


def _quote(value: str) -> str:
    """JSON.stringify(value), for messages that read the same as the TypeScript ones."""
    return json.dumps(value, ensure_ascii=False)


def filesystem_scope_issue(scope: str) -> Optional[str]:
    """filesystemScopeIssue() in capability.ts: a reason a filesystem: scope
    is not allowed, or None. Messages match the TypeScript ones."""
    if "\0" in scope:
        return "filesystem path must not contain a null byte"
    if not scope.startswith("/"):
        return f'filesystem path must be absolute (start with "/"), got {_quote(scope)}'
    path = scope[:-2] if scope.endswith("/*") else scope
    if "*" in path:
        return f'filesystem path may only use a trailing "/*" glob (a "*" anywhere else becomes a literal directory name), got {_quote(scope)}'
    prefixes = ", ".join(ALLOWED_FILESYSTEM_SCOPE_PREFIXES)
    if path == "/":
        return f"filesystem:*:/ would grant the entire container filesystem — declare a path under {prefixes} instead"
    segments = path[1:].split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return f'filesystem path must be canonical — no empty, "." or ".." segments, and no trailing slash — got {_quote(scope)}'
    if not any(path == prefix or path.startswith(f"{prefix}/") for prefix in ALLOWED_FILESYSTEM_SCOPE_PREFIXES):
        return f"filesystem path must be {prefixes} or a path beneath one of them, got {_quote(scope)}"
    return None


def filesystem_write_scope_issue(scope: str) -> Optional[str]:
    """filesystemWriteScopeIssue() in capability.ts: everything
    filesystem_scope_issue() refuses, and any path with a node_modules
    segment (an app's dependency tree, which a declared write path would have
    created as root and handed to the app). Messages match the TypeScript ones."""
    issue = filesystem_scope_issue(scope)
    if issue is not None:
        return issue
    path = scope[:-2] if scope.endswith("/*") else scope
    if "node_modules" in path.split("/"):
        return f"filesystem:write: may not name a path inside node_modules (an app's dependencies, which the sandbox's own tools load), got {_quote(scope)}"
    return None


def capability_issue(capability: str) -> Optional[str]:
    """capabilityIssue() in capability.ts: a reason `capability` is not an
    acceptable declaration, or None. Assumes the grammar already holds."""
    try:
        parsed = parse_capability(capability)
    except ValueError as err:
        return str(err)
    if parsed.namespace == "filesystem" and parsed.action == "write":
        return filesystem_write_scope_issue(parsed.scope)
    if parsed.namespace == "filesystem" and parsed.action == "read":
        return filesystem_scope_issue(parsed.scope)
    return None


# Mirrors @berthos/manifest-schema's resources.ts: the cgroup v2 files one app's
# `resources:` becomes, as the strings entrypoint.sh writes. Integer arithmetic
# with the same half-up rounding as the TypeScript, so the two compilers write
# identical policies (tests/test_policy_parity.py).
CPU_PERIOD_US = 100_000
_MIN_CPU_QUOTA_US = 1_000
DEFAULT_APP_PIDS = 1024
DEFAULT_APP_CPU_WEIGHT = 100


def app_cgroup_limits(resources: ResourcesSpec) -> dict[str, str]:
    """appCgroupLimits() in resources.ts."""
    limits = {"cpu.weight": str(DEFAULT_APP_CPU_WEIGHT)}
    if resources.cpu is not None:
        quota = max(_MIN_CPU_QUOTA_US, math.floor(resources.cpu * CPU_PERIOD_US + 0.5))
        limits["cpu.max"] = f"{quota} {CPU_PERIOD_US}"
    if resources.memory_mb is not None:
        # memory.max only, no memory.high: see resources.ts for why.
        limits["memory.max"] = str(resources.memory_mb * 1024 * 1024)
        limits["memory.swap.max"] = "0"
    limits["pids.max"] = str(resources.pids if resources.pids is not None else DEFAULT_APP_PIDS)
    return limits
