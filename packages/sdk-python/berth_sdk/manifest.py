"""Mirrors @berth/manifest-schema's schema.ts/capability.ts — the manifest
shape and capability-string grammar are plain data (YAML + a
namespace:action:scope string), not TypeScript-specific, so a Python
implementation validates the exact same shape rather than porting any code.
"""

from __future__ import annotations

import re
from typing import Literal

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


class BerthManifest(BaseModel):
    name: str
    version: str
    description: str = ""
    capabilities: list[str] = Field(default_factory=list)
    exports: list[ExportSpec] = Field(default_factory=list)
    on_install: list[str] = Field(default_factory=list)
    on_agent_ready: list[str] = Field(default_factory=list)

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
            if not CAPABILITY_RE.match(cap):
                raise ValueError(f"capability must be 'namespace:action:scope', got {cap!r}")
        return v


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
