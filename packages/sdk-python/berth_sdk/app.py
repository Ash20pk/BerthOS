"""Mirrors @berth/sdk's app.ts (defineApp/BerthApp/ExportDefinition). Python
has no default-export convention, so the equivalent authoring pattern is a
module-level `app = define_app(...)` — runtime.py looks for that attribute
name on the imported app module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from .manifest import BerthManifest


@dataclass
class ExportDefinition:
    name: str
    handler: Callable[[Any], Any]
    # Optional pydantic BaseModel subclasses — validated the same way zod
    # schemas validate input/output in the TS SDK's ExportDefinition.
    input_model: Optional[type] = None
    output_model: Optional[type] = None


class AppContext:
    """Semantic-fs's tag/query control API is deliberately out of scope for
    this SDK — see docs/sdk-python-reference.md. Direct file I/O against the
    FUSE-mounted /context already works from any process with zero SDK code,
    which is this SDK's honest v1 scope for context access. `context_bus` is
    real (see context_bus.py / local_context_bus.py, wired in by
    runtime.py)."""

    def __init__(self, manifest: BerthManifest, context_bus: Any) -> None:
        self.manifest = manifest
        self.context_bus = context_bus


class BerthApp:
    def __init__(self) -> None:
        self.exports: dict[str, ExportDefinition] = {}
        self.on_install_hooks: list[Callable[[], None]] = []
        self.on_agent_ready_hooks: list[Callable[[AppContext], None]] = []

    def export(
        self,
        name: str,
        handler: Callable[[Any], Any],
        input_model: Optional[type] = None,
        output_model: Optional[type] = None,
    ) -> None:
        if name in self.exports:
            raise ValueError(f'export "{name}" is already registered')
        self.exports[name] = ExportDefinition(name, handler, input_model, output_model)

    def on_install(self, fn: Callable[[], None]) -> None:
        self.on_install_hooks.append(fn)

    def on_agent_ready(self, fn: Callable[[AppContext], None]) -> None:
        self.on_agent_ready_hooks.append(fn)


def define_app(setup: Callable[[BerthApp], None]) -> BerthApp:
    app = BerthApp()
    setup(app)
    return app
