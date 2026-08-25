# `no-egress`

Once an agent can run code, "don't send my data anywhere" stops being something
a prompt can enforce. [`apps/code-interpreter`](../../apps/code-interpreter)
runs arbitrary Python/JS/shell as a real subprocess — and declares no network
capability, so the compiled policy grants zero egress. This demo runs
attacker-chosen code that tries to exfiltrate a secret three ways:

```
--- TCP connect to a raw IP:443 (Landlock net) ---   REFUSED: BLOCKED EACCES
--- DNS lookup over UDP :53 (seccomp) ---            REFUSED: BLOCKED EPERM
--- curl the secret out (shell, whole toolchain) --- REFUSED: BLOCKED curl-exit-7

PASS — the interpreter ran attacker-chosen code to completion, and every outbound
path was refused by the kernel because berth.yml never declared one.
```

Two layers, by design: Landlock scopes TCP connect (so an undeclared port is
`EACCES`), and a seccomp filter refuses UDP outright, because Landlock has no
datagram right — which is why DNS over `:53` dies with `EPERM`. Declaring
`network:connect:<port>` in `berth.yml` is what would open a specific hole.

No API key. Needs a kernel with Landlock — see the [examples README](../README.md).
