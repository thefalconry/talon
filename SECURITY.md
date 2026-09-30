# Security Policy

## Supported Versions

Only the latest minor release is supported. Talon is on a continuous-release
cadence — see [CHANGELOG.md](CHANGELOG.md) for the current version.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Talon, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/thefalconry/talon/security/advisories/new) to submit your report. This ensures the issue can be assessed and fixed before public disclosure.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix or mitigation for confirmed vulnerabilities as soon as practical

## Security measures

- **Bridge transport**: the companion bridge serves TLS by default whenever it
  binds a non-loopback host, using a persistent locally-minted certificate
  (ECDSA P-256) whose SHA-256 fingerprint clients pin on first connect.
- **Bridge auth**: bearer-token auth with constant-time comparison. A
  non-loopback bind with no configured token auto-mints a persistent one
  (`~/.talon/keys/bridge-token`) — the bridge is never open on the network.
- **Per-device credentials**: every paired device and node holds its own
  bearer credential (only a hash is stored), bound to its device id and
  scoped (`device` / `client` / `operator`); a credential can never act as
  another device, and `talon mesh revoke` cuts one device off and drops its
  live sessions. The shared token is a legacy path, accepted from remote
  clients only while `native.legacySharedToken` is on. See
  docs/mesh-credentials.md.
- **Brute-force lockout**: an address presenting repeated wrong tokens is
  refused (HTTP 429) for a cooldown window, and the lockout is logged for
  fail2ban-style tooling. Tokenless probes don't count — only wrong secrets.
- **Minimal pre-auth surface**: unauthenticated `/health` serves only what
  pairing needs (identity, protocol version, certificate fingerprint);
  operational details require the token.
- **At rest**: `~/.talon/`, `data/`, and `keys/` are clamped to owner-only
  (0700) on every boot; `config.json`, `talon.log`, `talon.db`, and the
  Telegram session file are clamped to 0600.

## Defaults: full capability, restrictions opt-in

Talon is built to be powerful out of the box. Every capability is on by
default; the restrictions below exist for operators who want them and are
off until you turn them on.

| Capability | Default | Opt-in restriction |
| --- | --- | --- |
| `fetch_url` reaching LAN / loopback / link-local addresses | allowed | `fetchUrl.allowPrivateNetworks: false` (SSRF guard, every redirect hop checked) |
| Companion credential scopes | `device`, `client`, `operator` | `native.companionScopes: ["device", "client"]`, or `talon mesh scopes <device> <list>` for one device |
| Companion device control (remote shell / files) | on | Settings → Mesh → Device control |
| Companion elevated access (root / Shizuku), root warmed at mesh start | on | Settings → Mesh → Elevated access |
| Grants carried over to a newly paired bridge | yes | Settings → Mesh → Ask again for each pairing |
| Companion command limits | 4 running, 16 waiting, 4 GiB per file write | Settings → Mesh (any value) |
| talon-node command limits | 8 workers, 4 GiB per file write | `policy` block in the node's `config.json` ([apps/node/README.md](apps/node/README.md)) |

## Scope

Talon is an AI agent with tool access (file system, web, messaging). Security issues of particular interest include:

- Prompt injection leading to unauthorized tool use
- Credential or token exposure in logs or responses
- Unauthorized access to the HTTP gateway
- Path traversal in file operations
- Dependency vulnerabilities with known exploits
