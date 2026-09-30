# The bystander in resource-limits-milestone.mjs: it asks for nothing, and
# has to keep answering — itself, and through the context-bus daemon — while
# its neighbour forks, allocates and spins.
import os
import threading
import time

from berth_sdk import define_app
from berth_sdk.context_bus import create_unix_socket_context_bus

APP = "cgroup-neighbour"


def whereami(_input):
    with open("/proc/self/cgroup") as f:
        return {"cgroup": f.read().strip(), "pid": os.getpid()}


def bus_roundtrip(_input):
    # A publish from one connection delivered to another: a round trip through
    # context-bus-daemon, which lives in the daemons' cgroup.
    socket_path = os.environ.get("BERTH_CONTEXT_BUS_SOCKET", "/tmp/berth-context-bus.sock")
    subscriber = create_unix_socket_context_bus(socket_path)
    publisher = create_unix_socket_context_bus(socket_path)
    subscriber.register(APP)
    publisher.register(APP)
    got = threading.Event()
    subscriber.subscribe("cgroup-milestone", lambda _payload: got.set())
    start = time.monotonic()
    delivered = False
    while not delivered and time.monotonic() - start < 10:
        publisher.publish("cgroup-milestone", {"at": time.time()})
        delivered = got.wait(0.5)
    return {"delivered": delivered, "ms": round((time.monotonic() - start) * 1000)}


def setup(a):
    a.export("ping", lambda _i: {"ok": True, "app": APP})
    a.export("whereami", whereami)
    a.export("bus_roundtrip", bus_roundtrip)


app = define_app(setup)
