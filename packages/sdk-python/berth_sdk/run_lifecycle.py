"""Mirrors @berth/sdk's run-lifecycle.ts: reports whether a browser:*
capability is declared, and separately whether a browser:navigate:*/
network:host:* capability is declared (entrypoint.sh's own trigger for
starting the egress broker), via the last stdout line ("1,1" / "0,1" / etc.)
— entrypoint.sh's Python branch parses this exactly like it already does for
the Node lifecycle script.

It used to also execute the manifest's on_install commands, once, tracked by
a marker file. That ran as uid 0 with no Landlock domain applied, before one
could exist (REMEDIATION.md 1.5); on_install is now a Docker build layer for
both build targets, and nothing runs it at container boot. See the fuller
note in run-lifecycle.ts. The marker file went with it — there is no longer a
boot-time action to run at most once.

Invoked as `python3 -m berth_sdk.run_lifecycle`.
"""

from __future__ import annotations

import os
from pathlib import Path

from .manifest import load_manifest


def main() -> None:
    manifest_path = os.environ.get("BERTH_MANIFEST_PATH", str(Path.cwd() / "berth.yml"))

    manifest = load_manifest(manifest_path)

    needs_browser = any(cap.startswith("browser:") for cap in manifest.capabilities)
    needs_egress_broker = any(cap.startswith("browser:navigate:") or cap.startswith("network:host:") for cap in manifest.capabilities)
    print(f"{'1' if needs_browser else '0'},{'1' if needs_egress_broker else '0'}")


if __name__ == "__main__":
    main()
