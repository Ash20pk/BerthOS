"""computer -> agent -> tool, from Python: connects to an already-running
`berth os up --http-rpc` instance and exposes its one designated app's
exports as a Tool list — the Python side of the local HTTP RPC bridge
documented in docs/agents-reference.md's "Reaching a Computer from outside
Node/Docker" section and docs/berth-os-reference.md's "Reaching an instance
without Docker API access" section. There is no Computer.boot() here: a
Python process has no way to drive Docker itself (no dockerode equivalent
wired up), only to connect to an instance a `berth os up --http-rpc` call
already started. See docs/agents-python-reference.md for the full scope
boundary this sits inside."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import yaml

DEFAULT_OS_DIR = Path.home() / ".berth" / "os"

# berth.yml's IOSpec is a flat map of field name -> one of these primitive
# type names (see @berth/manifest-schema's JsonPrimitiveType) — the same
# 5-case table packages/agents/src/tools.ts's zodFor()/inputSchemaFor()
# mechanically walks to reach JSON Schema, just without zod as an
# intermediate step, since the source data here is already plain YAML.
_JSON_SCHEMA_TYPE_FOR = {
    "string": {"type": "string"},
    "number": {"type": "number"},
    "boolean": {"type": "boolean"},
    "object": {"type": "object"},
    "array": {"type": "array"},
}


class ComputerConnectionError(Exception):
    """Raised when `Computer.connect()` can't find or use a named instance —
    no recorded state, a state file with no `httpRpc` (started without
    `berth os up --http-rpc`), or the bridge app's `berth.yml` is missing."""


def _input_schema_for(io_spec: dict[str, str]) -> dict[str, Any]:
    properties = {field: _JSON_SCHEMA_TYPE_FOR[type_name] for field, type_name in io_spec.items()}
    return {"type": "object", "properties": properties, "required": list(io_spec.keys())}


class _HttpTool:
    """One resident-app export, reachable over the HTTP RPC bridge — the
    Python counterpart to a Tool computerToolsFor() builds in tools.ts,
    minus the app__export namespacing, since the bridge only ever serves
    one single app's own bare export names (see the module docstring)."""

    def __init__(self, name: str, description: str, input_schema: dict[str, Any], client: "_HttpRpcClient") -> None:
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self._client = client

    async def invoke(self, input: Any) -> Any:
        return await self._client.call(self.name, input)


class _HttpRpcClient:
    def __init__(self, url: str, token: str) -> None:
        self._url = url
        self._token = token

    async def call(self, export_name: str, input: Any) -> Any:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._url}/rpc",
                json={"id": "1", "export": export_name, "input": input},
                headers={"authorization": f"Bearer {self._token}"},
            )
        body = response.json()
        if "error" in body:
            raise RuntimeError(body["error"])
        return body["result"]


class ComputerHandle:
    """What an Agent/Crew actually needs from a Computer — the Python
    mirror of computer.ts's ComputerHandle interface, minus boot()/the
    Docker-owning lifecycle Computer.boot() has in TypeScript: this side can
    only ever connect to an instance something else started."""

    def __init__(self, tools: list[_HttpTool]) -> None:
        self.tools: list[Any] = tools

    async def call(self, tool_name: str, input: Any) -> Any:
        tool = next((t for t in self.tools if t.name == tool_name), None)
        if tool is None:
            raise RuntimeError(f'no such tool "{tool_name}" — available: {", ".join(t.name for t in self.tools)}')
        return await tool.invoke(input)

    async def stop(self) -> None:
        """A no-op, same reasoning as Computer.connect()'s stop() in
        TypeScript: this container is a long-lived OS other processes may
        still be using, not something this handle owns the lifecycle of.
        Use `berth os down <name>` to actually tear it down."""
        return None


class Computer:
    @staticmethod
    async def connect(name: str, *, os_dir: str | Path | None = None) -> ComputerHandle:
        """Reads `~/.berth/os/<name>.json` (written by `berth os up
        --http-rpc`), loads the designated bridge app's `berth.yml` directly
        off disk (the state file only ever records `{name, appDir}` pairs,
        not manifest data — same thing TypeScript's own Computer.connect()
        does, it just re-reads through @berth/manifest-schema instead of
        plain YAML), and returns a ComputerHandle exposing that one app's
        exports as Tools reachable over HTTP.
        """
        state_path = Path(os_dir or DEFAULT_OS_DIR) / f"{name}.json"
        try:
            state = json.loads(state_path.read_text())
        except FileNotFoundError:
            raise ComputerConnectionError(
                f'no Berth OS named "{name}" (no state file at {state_path}) — start one first with '
                f"`berth os up {name} --apps=<dir> --http-rpc`"
            ) from None

        http_rpc = state.get("httpRpc")
        if not http_rpc:
            raise ComputerConnectionError(
                f'"{name}" was started without --http-rpc — a Python Computer.connect() needs the HTTP bridge; '
                f're-run `berth os up {name} ... --http-rpc`'
            )

        apps = state.get("apps", [])
        bridge_app_name = http_rpc.get("app") or (apps[0]["name"] if apps else None)
        app_record = next((a for a in apps if a["name"] == bridge_app_name), None)
        if not app_record:
            raise ComputerConnectionError(
                f'"{name}"\'s recorded httpRpc.app "{bridge_app_name}" isn\'t among its loaded apps: '
                f'{", ".join(a["name"] for a in apps) or "(none)"}'
            )

        manifest_path = Path(app_record["appDir"]) / "berth.yml"
        try:
            manifest = yaml.safe_load(manifest_path.read_text())
        except FileNotFoundError:
            raise ComputerConnectionError(f"bridge app \"{bridge_app_name}\"'s berth.yml is missing at {manifest_path}") from None

        client = _HttpRpcClient(http_rpc["url"], http_rpc["token"])
        tools = [
            _HttpTool(
                name=export["name"],
                description=f'Berth resident app export "{export["name"]}" (from {bridge_app_name}\'s berth.yml)',
                input_schema=_input_schema_for(export.get("input") or {}),
                client=client,
            )
            for export in manifest.get("exports", [])
        ]

        return ComputerHandle(tools)
