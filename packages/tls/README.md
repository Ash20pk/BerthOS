# @berthos/tls

TLS helpers shared by Berth's servers and CLI: load certificates, generate self-signed ones for development, and trust a custom CA on the client side.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/tls
```

## Usage

```ts
import { generateSelfSignedCerts, resolveServerTlsFromEnv, trustCa } from "@berthos/tls";

const certs = generateSelfSignedCerts({ dir: "./certs" }); // localhost, 127.0.0.1 and ::1, valid 365 days
// -> { caCertPath, certPath, keyPath }

// Reads MYSERVER_TLS_CERT, MYSERVER_TLS_KEY, MYSERVER_TLS_CA, MYSERVER_TLS_REQUIRE_CLIENT_CERT
const tls = resolveServerTlsFromEnv("MYSERVER");

trustCa(certs.caCertPath); // client side: trust that CA for outgoing HTTPS
```

`generateSelfSignedCerts()` needs `openssl` on `PATH`. The CLI's `berth tls init` does the same generation for you.

## Docs

[TLS reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/tls-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
