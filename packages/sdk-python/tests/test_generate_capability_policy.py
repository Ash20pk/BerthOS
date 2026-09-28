import json

from berth_sdk import generate_capability_policy


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
