# `no-egress`

Once an agent can run code, a prompt can't stop it sending your data somewhere. [`apps/code-interpreter`](../../apps/code-interpreter) runs arbitrary Python, JavaScript and shell as real subprocesses, and declares no network capability, so its policy allows no outbound traffic. This demo runs attacker-chosen code that tries to get a secret out three ways.

## Run it

Needs Docker and a kernel with Landlock network rules (Linux 6.7+; check with `berth doctor`). No API key.

```bash
pnpm install && pnpm build      # once, from the repo root
cd examples/no-egress
pnpm start
```

## Expected output

```
--- TCP connect to a raw IP:443 (Landlock net) ---
  REFUSED: BLOCKED EACCES

--- DNS lookup over UDP :53 (seccomp) ---
  REFUSED: BLOCKED EPERM

--- curl the secret out (shell, whole toolchain) ---
  REFUSED: BLOCKED curl-exit-7

PASS — the interpreter ran attacker-chosen code to completion, and every outbound path was
refused by the kernel because berth.yml never declared one. Egress is a capability, not a default.
```

Two kernel layers do this. Landlock controls TCP connect, so a connection to an undeclared port fails with `EACCES`. Landlock has no rule for UDP, so a seccomp filter refuses UDP sockets outright, which is why DNS fails with `EPERM`. Declaring `network:connect:<port>` in `berth.yml` is what opens a specific port.

On a machine that can't enforce, the demo refuses to boot. `BERTH_ALLOW_UNENFORCED=1` boots it anyway, and it reports that the blocks weren't real and exits 1. See the [examples README](../README.md).
