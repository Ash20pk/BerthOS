import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from berth_sdk.check_exports import run_checks, stub_model_input

REPO_ROOT = Path(__file__).resolve().parents[3]
SDK_ROOT = Path(__file__).resolve().parents[1]


class Nested(BaseModel):
    flag: bool


class Everything(BaseModel):
    url: str
    name: str
    count: int
    ratio: float
    tags: list[str]
    meta: dict[str, str]
    nested: Nested
    maybe: Optional[str] = None
    defaulted: int = 3


def test_stub_input_validates_against_the_model():
    stub = stub_model_input(Everything)
    assert stub == {"url": "https://example.com", "name": "berth-test-stub", "count": 1, "ratio": 1, "tags": [], "meta": {}, "nested": {"flag": True}}
    Everything.model_validate(stub)


def _app(tmp: Path, manifest: str, code: str) -> tuple[str, str]:
    (tmp / "src").mkdir()
    (tmp / "berth.yml").write_text(manifest)
    (tmp / "src" / "app.py").write_text(code)
    return str(tmp / "berth.yml"), str(tmp / "src" / "app.py")


def test_hello_world_py_passes():
    app_dir = REPO_ROOT / "apps" / "hello-world-py"
    summary = run_checks(str(app_dir / "berth.yml"), str(app_dir / "src" / "app.py"))
    assert summary == {"ok": True, "results": [{"export": "greet", "ok": True}, {"export": "publish_file_created", "ok": True}]}


def test_an_export_mismatch_is_reported(short_tmp):
    manifest, entry = _app(
        short_tmp,
        "name: a\nversion: 1.0.0\nexports:\n  - name: declared\n",
        "from berth_sdk import define_app\napp = define_app(lambda a: a.export('implemented', lambda i: i))\n",
    )
    summary = run_checks(manifest, entry)
    assert summary["ok"] is False
    assert summary["missingInCode"] == ["declared"]
    assert summary["missingInManifest"] == ["implemented"]


def test_a_failing_handler_or_bad_output_is_a_failed_result(short_tmp):
    manifest, entry = _app(
        short_tmp,
        "name: a\nversion: 1.0.0\nexports:\n  - name: boom\n  - name: bad_output\n",
        "from pydantic import BaseModel\n"
        "from berth_sdk import define_app\n"
        "class Out(BaseModel):\n    n: int\n"
        "def boom(_):\n    raise ValueError('nope')\n"
        "def setup(a):\n"
        "    a.export('boom', boom)\n"
        "    a.export('bad_output', lambda _: {'n': 'not a number'}, output_model=Out)\n"
        "app = define_app(setup)\n",
    )
    summary = run_checks(manifest, entry)
    assert summary["ok"] is False
    by_name = {r["export"]: r for r in summary["results"]}
    assert by_name["boom"] == {"export": "boom", "ok": False, "error": "nope"}
    assert by_name["bad_output"]["ok"] is False


def test_the_module_prints_one_json_line_and_sets_the_exit_code():
    app_dir = REPO_ROOT / "apps" / "hello-world-py"
    completed = subprocess.run(
        [sys.executable, "-m", "berth_sdk.check_exports"],
        cwd=app_dir,
        env={"PYTHONPATH": str(SDK_ROOT), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout.strip().splitlines()[-1])["ok"] is True
