# The greedy half of resource-limits-milestone.mjs. Every export here does
# the thing a neighbour should not have to pay for, and reports what the
# kernel said, so the milestone can check the answer came from this app's
# own cgroup and not from the sandbox's.
import errno
import os
import signal
import subprocess
import sys
import time

from berth_sdk import define_app

APP = "cgroup-hog"


def whereami(_input):
    with open("/proc/self/cgroup") as f:
        return {"cgroup": f.read().strip(), "pid": os.getpid()}


def fork_bomb(input):
    # Children that do nothing but wait, so every one of them is a task the
    # cgroup has to count. Stops at the first refusal, holds the cgroup at
    # its limit for `hold` seconds (the milestone calls the neighbour in that
    # window), then cleans up.
    count, hold = int(input["count"]), float(input.get("hold", 0))
    children, error = [], None
    for _ in range(count):
        try:
            pid = os.fork()
        except OSError as err:
            error = errno.errorcode.get(err.errno, str(err.errno))
            break
        if pid == 0:
            time.sleep(60)
            os._exit(0)
        children.append(pid)
    time.sleep(hold)
    for pid in children:
        os.kill(pid, signal.SIGKILL)
    for pid in children:
        os.waitpid(pid, 0)
    return {"forked": len(children), "error": error}


def alloc(input):
    # In a child, so that what the kernel stops is the allocation and not this
    # app's runtime: the app surviving its own overreach is the point. Past
    # memory.high the child is throttled, and past memory.max it is killed;
    # with no swap to reclaim into, the throttling alone can outlast
    # `timeout`, which is reported rather than waited out.
    mb, timeout = int(input["mb"]), float(input.get("timeout", 30))
    code = f"b = bytearray({mb} * 1024 * 1024)\nfor i in range(0, len(b), 4096): b[i] = 1\nprint('allocated')"
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return {"returncode": proc.returncode, "allocated": "allocated" in out, "timed_out": False}
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return {"returncode": proc.returncode, "allocated": False, "timed_out": True}


def spin(input):
    # Detached busy loops; they end themselves after `seconds`.
    workers, seconds = int(input["workers"]), float(input["seconds"])
    code = f"import time\nend = time.time() + {seconds}\nwhile time.time() < end: pass"
    for _ in range(workers):
        subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"started": workers}


def _attempt(fn):
    try:
        fn()
        return "ok"
    except OSError as err:
        return errno.errorcode.get(err.errno, str(err.errno))


def _write(path, value):
    def go():
        with open(path, "w") as f:
            f.write(value)
    return go


def escape_cgroup(_input):
    # Every way out of, or around, this app's limits that a process could try
    # without a capability. Each must be refused.
    own = f"/sys/fs/cgroup/berth/apps/{APP}"
    pid = str(os.getpid())
    return {
        "own cgroup.procs": _attempt(_write(f"{own}/cgroup.procs", pid)),
        "daemons cgroup.procs": _attempt(_write("/sys/fs/cgroup/berth/daemons/cgroup.procs", pid)),
        "sibling cgroup.procs": _attempt(_write("/sys/fs/cgroup/berth/apps/cgroup-neighbour/cgroup.procs", pid)),
        "root cgroup.procs": _attempt(_write("/sys/fs/cgroup/cgroup.procs", pid)),
        "own memory.max": _attempt(_write(f"{own}/memory.max", "max")),
        "own pids.max": _attempt(_write(f"{own}/pids.max", "max")),
        "own cpu.max": _attempt(_write(f"{own}/cpu.max", "max")),
        "apps memory.max": _attempt(_write("/sys/fs/cgroup/berth/apps/memory.max", "max")),
        "mkdir child cgroup": _attempt(lambda: os.mkdir(f"{own}/escape")),
    }


def setup(a):
    a.export("ping", lambda _i: {"ok": True, "app": APP})
    a.export("whereami", whereami)
    a.export("fork_bomb", fork_bomb)
    a.export("alloc", alloc)
    a.export("spin", spin)
    a.export("escape_cgroup", escape_cgroup)


app = define_app(setup)
