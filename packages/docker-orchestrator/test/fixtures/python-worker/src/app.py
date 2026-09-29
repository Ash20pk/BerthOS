import json, socket
from berth_sdk import define_app

def call_target(_input):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect("/run/berth/python-target/peers/python-worker/rpc.sock")
        s.sendall(json.dumps({"id": "x", "export": "whoami", "input": None}).encode() + b"\n")
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf.split(b"\n")[0])

def setup(a):
    a.export("ok", lambda _i: {"ran": "ok"})
    a.export("blocked", lambda _i: {"ran": "blocked"})
    a.export("call_target", call_target)

app = define_app(setup)
