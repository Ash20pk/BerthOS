import json
import os

from berth_sdk import generate_capability_policy
from berth_sdk.generate_capability_policy import _sdk_read_paths


def test_main_writes_the_policy_and_logs_to_stderr(short_tmp, clean_env, capsys):
    manifest = short_tmp / "berth.yml"
    manifest.write_text(
        "name: py-app\nversion: 1.0.0\nruntime: python\ncapabilities:\n  - network:bind:8080\n  - network:peer:crew-*\n  - terminal:attach:*\n"
    )
    policy_path = short_tmp / ".berth" / "capability-policy.json"
    clean_env.setenv("BERTH_MANIFEST_PATH", str(manifest))
    clean_env.setenv("BERTH_CAPABILITY_POLICY", str(policy_path))
    clean_env.setenv("BERTH_HTTP_RPC_PORT", "7777")
    clean_env.setenv("BERTH_HTTP_RPC_APP", "py-app")

    generate_capability_policy.main()

    policy = json.loads(policy_path.read_text())
    assert policy["bindPorts"] == [8080, 7777, 7681]
    assert policy["meshPeers"] == ["crew-*"]
    assert policy["networkPorts"] == [4875]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "[berth:capability-policy] wrote" in captured.err


def test_pythonpath_entries_are_filtered_to_narrow_existing_directories(short_tmp, capsys):
    root = os.path.realpath(short_tmp)
    sdk = os.path.join(root, "packages", "sdk-python")
    app = os.path.join(root, "apps", "hello")
    os.makedirs(sdk)
    os.makedirs(app)
    link = os.path.join(root, "sdk-link")
    os.symlink(sdk, link)
    pythonpath = ":".join(
        ["/", "", "relative/dir", os.path.join(root, "missing"), root, os.path.join(root, "apps"), app, sdk, link, "/usr"]
    )
    paths = _sdk_read_paths(pythonpath, app)
    # The link resolves to the SDK directory, so that is granted once. "/", a top-level directory such as
    # /usr, and anything containing the app (its workspace, apps/, the app itself) are too broad.
    assert paths == [sdk]
    # Warnings go to stderr, as every other one this module prints: stdout stays clean.
    assert capsys.readouterr().out == ""


def test_pythonpath_entries_that_are_another_apps_directory_are_refused(short_tmp, capsys):
    root = os.path.realpath(short_tmp)
    sdk = os.path.join(root, "packages", "sdk-python")
    app = os.path.join(root, "apps", "hello")
    # Another app under apps/, even with no berth.yml of its own yet.
    other = os.path.join(root, "apps", "other")
    # An example app outside apps/, and a directory within it.
    example = os.path.join(root, "examples", "resident-apps", "demo")
    example_lib = os.path.join(example, "lib")
    for d in (sdk, app, other, example_lib):
        os.makedirs(d)
    with open(os.path.join(example, "berth.yml"), "w") as f:
        f.write("name: demo\n")
    examples = os.path.join(root, "examples")
    resident = os.path.join(examples, "resident-apps")
    pythonpath = ":".join([other, example, example_lib, examples, resident, sdk])
    paths = _sdk_read_paths(pythonpath, app)
    # Only the SDK survives: the others are an app, part of one, or hold one.
    assert paths == [sdk]
    assert capsys.readouterr().err.count("another app's directory") == 5


def test_an_empty_pythonpath_grants_nothing():
    assert _sdk_read_paths("", "/workspace/apps/x") == []


def test_the_sdk_is_granted_after_the_baseline_and_reads_are_always_scoped(short_tmp, clean_env):
    root = os.path.realpath(short_tmp)
    sdk = os.path.join(root, "packages", "sdk-python")
    app = os.path.join(root, "apps", "hello")
    os.makedirs(sdk)
    os.makedirs(app)
    clean_env.setenv("PYTHONPATH", sdk)
    policy = generate_capability_policy.compile_capability_policy("hello", [], cwd=app)
    baseline = ["/usr", "/bin", "/sbin", "/lib", "/etc", "/proc", "/dev", "/tmp", "/run/berth/hello", app]
    # Same order as the TypeScript compiler: baseline, then where the SDK/dependencies live.
    assert policy["readPaths"] == [*baseline, sdk]
