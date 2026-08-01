"""Mirrors @berth/sdk's runtime.ts boot sequence: load manifest -> import the
app module -> assert exports match manifest -> run hooks -> serve RPC. The
orchestration itself is idiomatic Python (importlib, not a port of Node's
dynamic import()) — only the wire protocols (manifest shape, RPC framing)
are shared with the TypeScript SDK, not this glue code.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from .app import AppContext, BerthApp
from .manifest import load_manifest
from .rpc import serve_stdio_forever, start_rpc_server


def _assert_exports_match_manifest(app: BerthApp, declared_exports: list[str]) -> None:
    code_exports = set(app.exports.keys())
    manifest_exports = set(declared_exports)

    missing_in_code = sorted(manifest_exports - code_exports)
    missing_in_manifest = sorted(code_exports - manifest_exports)

    if missing_in_code or missing_in_manifest:
        problems = []
        if missing_in_code:
            problems.append(f"declared in berth.yml but not implemented: {', '.join(missing_in_code)}")
        if missing_in_manifest:
            problems.append(f"implemented in code but not declared in berth.yml: {', '.join(missing_in_manifest)}")
        raise RuntimeError(f"exports mismatch between berth.yml and app code — {'; '.join(problems)}")


def main() -> None:
    app_root = Path(os.getcwd())
    manifest_path = os.environ.get("BERTH_MANIFEST_PATH", str(app_root / "berth.yml"))
    app_entry = os.environ.get("BERTH_APP_ENTRY", str(app_root / "src" / "app.py"))

    print(f"[berth:runtime] loading manifest from {manifest_path}", file=sys.stderr)
    manifest = load_manifest(manifest_path)

    print(f"[berth:runtime] loading app entry {app_entry}", file=sys.stderr)
    spec = importlib.util.spec_from_file_location("berth_app_entry", app_entry)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load a Python module from {app_entry}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    app = getattr(module, "app", None)
    if not isinstance(app, BerthApp):
        raise RuntimeError(f"{app_entry} must define a module-level `app = define_app(...)`")

    _assert_exports_match_manifest(app, [e.name for e in manifest.exports])

    for hook in app.on_install_hooks:
        hook()

    ctx = AppContext(manifest)
    for hook in app.on_agent_ready_hooks:
        hook(ctx)

    start_rpc_server(app, socket_path=os.environ.get("BERTH_RPC_SOCKET"))
    print(f'[berth:runtime] "{manifest.name}" ready', file=sys.stderr)

    # Blocks forever, reading stdio RPC requests — this is what keeps the
    # process alive, same role Node's active readline listener plays in
    # rpc.ts (its event loop just never empties).
    serve_stdio_forever(app)


if __name__ == "__main__":
    main()
