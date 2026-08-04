"""Mirrors @berth/sdk's run-lifecycle.ts: runs each on_install command once
(tracked via a marker file), then reports whether a browser:* capability is
declared, and separately whether a browser:navigate:*/network:host:*
capability is declared (entrypoint.sh's own trigger for starting the egress
broker), via the last stdout line ("1,1" / "0,1" / etc.) — entrypoint.sh's
Python branch parses this exactly like it already does for the Node
lifecycle script.
Invoked as `python3 -m berth_sdk.run_lifecycle`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from .manifest import load_manifest


def main() -> None:
    manifest_path = os.environ.get("BERTH_MANIFEST_PATH", str(Path.cwd() / "berth.yml"))
    marker_path = Path(os.environ.get("BERTH_INSTALL_MARKER", str(Path.cwd() / ".berth" / "installed")))

    manifest = load_manifest(manifest_path)

    if not marker_path.exists():
        for command in manifest.on_install:
            print(f"[berth:lifecycle] running on_install: {command}", file=sys.stderr)
            subprocess.run(command, shell=True, check=True, cwd=Path.cwd())
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        marker_path.write_text(datetime.now(timezone.utc).isoformat())
    else:
        print(f"[berth:lifecycle] on_install already ran (marker at {marker_path}), skipping", file=sys.stderr)

    needs_browser = any(cap.startswith("browser:") for cap in manifest.capabilities)
    needs_egress_broker = any(cap.startswith("browser:navigate:") or cap.startswith("network:host:") for cap in manifest.capabilities)
    print(f"{'1' if needs_browser else '0'},{'1' if needs_egress_broker else '0'}")


if __name__ == "__main__":
    main()
