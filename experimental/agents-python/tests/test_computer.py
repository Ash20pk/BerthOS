import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from berth_agents import Computer, ComputerConnectionError

VALID_TOKEN = "test-token-123"


class _FakeRpcHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # silence test output
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self._respond(200, {"ok": True})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/rpc":
            self._respond(404, {"error": "not found"})
            return
        if self.headers.get("Authorization") != f"Bearer {VALID_TOKEN}":
            self._respond(401, {"error": "invalid or missing bearer token"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        if body["export"] == "write_file":
            self._respond(200, {"id": body["id"], "result": None})
        elif body["export"] == "read_file":
            self._respond(200, {"id": body["id"], "result": {"content": "fake content"}})
        else:
            self._respond(200, {"id": body["id"], "error": f'no such export "{body["export"]}"'})

    def _respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def fake_bridge_server():
    server = HTTPServer(("127.0.0.1", 0), _FakeRpcHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def write_os_state(os_dir, name, *, apps, http_rpc):
    os_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "name": name,
        "containerName": f"berth-os-{name}",
        "image": "berth-os/fake:latest",
        "apps": apps,
        "startedAt": "2026-08-05T00:00:00.000Z",
        "httpRpc": http_rpc,
    }
    (os_dir / f"{name}.json").write_text(json.dumps(state))


def write_manifest(app_dir, exports):
    app_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"name": app_dir.name, "version": "1.0.0", "exports": exports}
    (app_dir / "berth.yml").write_text(
        "\n".join(
            [
                f"name: {manifest['name']}",
                f"version: {manifest['version']}",
                "exports:",
                *[
                    f"  - name: {e['name']}"
                    + ("\n    input: {" + ", ".join(f"{k}: {v}" for k, v in e["input"].items()) + "}" if e.get("input") else "")
                    for e in exports
                ],
            ]
        )
    )


@pytest.mark.asyncio
async def test_connect_builds_tools_from_the_bridge_apps_manifest(tmp_path, fake_bridge_server):
    app_dir = tmp_path / "filesystem"
    write_manifest(
        app_dir,
        [
            {"name": "write_file", "input": {"path": "string", "content": "string"}},
            {"name": "read_file", "input": {"path": "string"}},
        ],
    )
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(app_dir)}],
        http_rpc={"url": fake_bridge_server, "token": VALID_TOKEN},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")

    tool_names = sorted(t.name for t in computer.tools)
    assert tool_names == ["read_file", "write_file"]

    write_tool = next(t for t in computer.tools if t.name == "write_file")
    assert write_tool.input_schema == {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
    }


@pytest.mark.asyncio
async def test_call_round_trips_through_the_real_http_bridge(tmp_path, fake_bridge_server):
    app_dir = tmp_path / "filesystem"
    write_manifest(app_dir, [{"name": "read_file", "input": {"path": "string"}}])
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(app_dir)}],
        http_rpc={"url": fake_bridge_server, "token": VALID_TOKEN},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")
    result = await computer.call("read_file", {"path": "x.txt"})

    assert result == {"content": "fake content"}


@pytest.mark.asyncio
async def test_call_raises_on_a_wrong_bearer_token(tmp_path, fake_bridge_server):
    app_dir = tmp_path / "filesystem"
    write_manifest(app_dir, [{"name": "read_file", "input": {"path": "string"}}])
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(app_dir)}],
        http_rpc={"url": fake_bridge_server, "token": "wrong-token"},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")

    with pytest.raises(Exception):
        await computer.call("read_file", {"path": "x.txt"})


@pytest.mark.asyncio
async def test_call_raises_a_clear_error_for_an_unknown_tool(tmp_path, fake_bridge_server):
    app_dir = tmp_path / "filesystem"
    write_manifest(app_dir, [{"name": "read_file", "input": {"path": "string"}}])
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(app_dir)}],
        http_rpc={"url": fake_bridge_server, "token": VALID_TOKEN},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")

    with pytest.raises(RuntimeError, match="no such tool"):
        await computer.call("nonexistent_tool", {})


@pytest.mark.asyncio
async def test_connect_raises_when_no_state_file_exists(tmp_path):
    with pytest.raises(ComputerConnectionError, match="no Berth OS named"):
        await Computer.connect("nonexistent", os_dir=tmp_path / "os")


@pytest.mark.asyncio
async def test_connect_raises_when_the_instance_wasnt_started_with_http_rpc(tmp_path):
    app_dir = tmp_path / "filesystem"
    write_manifest(app_dir, [{"name": "read_file", "input": {"path": "string"}}])
    write_os_state(tmp_path / "os", "my-agent", apps=[{"name": "filesystem", "appDir": str(app_dir)}], http_rpc=None)

    with pytest.raises(ComputerConnectionError, match="--http-rpc"):
        await Computer.connect("my-agent", os_dir=tmp_path / "os")


@pytest.mark.asyncio
async def test_connect_defaults_to_the_designated_bridge_app_in_a_multi_app_instance(tmp_path, fake_bridge_server):
    filesystem_dir = tmp_path / "filesystem"
    code_editor_dir = tmp_path / "code-editor"
    write_manifest(filesystem_dir, [{"name": "write_file", "input": {"path": "string", "content": "string"}}])
    write_manifest(code_editor_dir, [{"name": "open_file", "input": {"path": "string"}}])
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(filesystem_dir)}, {"name": "code-editor", "appDir": str(code_editor_dir)}],
        http_rpc={"url": fake_bridge_server, "token": VALID_TOKEN, "app": "filesystem"},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")

    tool_names = sorted(t.name for t in computer.tools)
    assert tool_names == ["write_file"], "expected only the designated bridge app's (filesystem's) exports, bare-named"


@pytest.mark.asyncio
async def test_stop_is_a_no_op(tmp_path, fake_bridge_server):
    app_dir = tmp_path / "filesystem"
    write_manifest(app_dir, [{"name": "read_file", "input": {"path": "string"}}])
    write_os_state(
        tmp_path / "os",
        "my-agent",
        apps=[{"name": "filesystem", "appDir": str(app_dir)}],
        http_rpc={"url": fake_bridge_server, "token": VALID_TOKEN},
    )

    computer = await Computer.connect("my-agent", os_dir=tmp_path / "os")

    await computer.stop()
    # Still usable afterward — stop() didn't tear anything down.
    result = await computer.call("read_file", {"path": "x.txt"})
    assert result == {"content": "fake content"}
