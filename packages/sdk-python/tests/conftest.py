import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# The tests import the in-tree berth_sdk, not an installed copy.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def short_tmp():
    """A temp dir under /tmp rather than pytest's tmp_path: a Unix socket path
    is capped at ~104 bytes (sun_path), and macOS's default temp dir is long
    enough to overflow it once /run/berth/<app>/peers/<caller>/rpc.sock is
    appended — the same reason governance-gate.test.ts uses /tmp."""
    root = tempfile.mkdtemp(prefix="berth-py-", dir="/tmp")
    try:
        yield Path(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def clean_env(monkeypatch):
    for name in list(os.environ):
        if name.startswith("BERTH_"):
            monkeypatch.delenv(name, raising=False)
    return monkeypatch
