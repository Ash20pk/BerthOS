"""Mirrors @berthos/sdk's check-exports.ts, for `berth test` on a
`runtime: python` app: loads the app, cross-checks its exports against
berth.yml (the check runtime.py makes at boot), then invokes every export
with a schema-valid stub input and validates the output. Prints one JSON line,
the same shape check-exports.ts prints, and exits non-zero on any failure.

Invoked as `python3 -m berth_sdk.check_exports`.
"""

from __future__ import annotations

import json
import os
import sys
import types
import typing
from typing import Any, Optional

from .manifest import load_manifest
from .runtime import default_paths, load_app

# The same field-name hints stub-value.ts uses: a random string satisfies a
# `str` field, but a handler given a field named "url" may reasonably reject
# anything that isn't one.
FIELD_NAME_HINTS = {
    "url": "https://example.com",
    "selector": "body",
    "email": "test@example.com",
}

_OMIT = object()


def stub_value(annotation: Any, field_name: Optional[str] = None) -> Any:
    """A value that validates against `annotation` — a pydantic model, a
    primitive type, or a list/dict/Optional of them. Optional fields are
    omitted, as stub-value.ts leaves them undefined."""
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    if origin is typing.Union or (hasattr(types, "UnionType") and origin is types.UnionType):
        if type(None) in args:
            return _OMIT
        return stub_value(args[0], field_name) if args else None
    if origin is typing.Annotated:
        return stub_value(args[0], field_name)
    if origin is typing.Literal:
        return args[0] if args else None
    if origin in (list, tuple, set, frozenset):
        return []
    if origin is dict:
        return {}

    if annotation is str:
        return FIELD_NAME_HINTS.get(field_name or "", "berth-test-stub")
    if annotation is bool:
        return True
    if annotation in (int, float):
        return 1
    if annotation in (list, tuple, set, frozenset):
        return []
    if annotation is dict:
        return {}
    if isinstance(annotation, type) and hasattr(annotation, "model_fields"):
        return stub_model_input(annotation)
    return None


def stub_model_input(model: type) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for name, field in model.model_fields.items():  # type: ignore[attr-defined]
        if not field.is_required():
            continue
        value = stub_value(field.annotation, name)
        if value is not _OMIT:
            payload[field.alias or name] = value
    return payload


def run_checks(manifest_path: str, app_entry: str) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    app = load_app(app_entry)

    code_exports = list(app.exports.keys())
    manifest_exports = [e.name for e in manifest.exports]
    missing_in_code = [name for name in manifest_exports if name not in app.exports]
    missing_in_manifest = [name for name in code_exports if name not in manifest_exports]
    if missing_in_code or missing_in_manifest:
        return {
            "ok": False,
            "error": "exports mismatch between berth.yml and app code",
            "missingInCode": missing_in_code,
            "missingInManifest": missing_in_manifest,
        }

    results = []
    for name in code_exports:
        definition = app.exports[name]
        try:
            raw = stub_model_input(definition.input_model) if definition.input_model else None
            parsed = definition.input_model.model_validate(raw) if definition.input_model else raw
            result = definition.handler(parsed)
            if definition.output_model is not None and not isinstance(result, definition.output_model):
                definition.output_model.model_validate(result)
            results.append({"export": name, "ok": True})
        except Exception as err:  # noqa: BLE001 - every handler failure is a reported result
            results.append({"export": name, "ok": False, "error": str(err)})

    return {"ok": all(r["ok"] for r in results), "results": results}


def main() -> None:
    manifest_path, app_entry = default_paths()
    try:
        summary = run_checks(manifest_path, app_entry)
    except Exception as err:  # noqa: BLE001 - reported as the one JSON line berth test parses
        summary = {"ok": False, "error": str(err)}
    print(json.dumps(summary), flush=True)
    # Explicit, as check-exports.ts does: a handler may leave a thread or
    # socket open that would otherwise keep the process alive.
    sys.stderr.flush()
    os._exit(0 if summary["ok"] else 1)


if __name__ == "__main__":
    main()
