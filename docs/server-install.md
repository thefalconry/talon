# Server-only install (no Telegram)

Run Talon on a Linux server with no chat bot at all. The only way in is the
client bridge: the [companion app](../apps/companion/) on your phone or
desktop, and [talon-node](headless-node.md) on other machines. There's no
bot token, no admin ID, and nothing that talks to Telegram.

```
companion app ──┐
                ├──HTTPS + token──▶ talon (frontend: native) :19880 ──▶ backend (claude, codex, agy…)
talon-node ─────┘
```

## 1. Install

Pick one. All of them put `talon` on `PATH`.

```bash
# Fedora / RHEL: the .rpm from the latest release
sudo dnf install ./talon-<version>-1.x86_64.rpm      # or .aarch64.rpm

# Debian / Ubuntu: the .deb from the latest release
sudo apt install ./talon_<version>_amd64.deb         # or _arm64.deb

# Anything else with Node 24+
npm install -g talon-agent
```

For Docker, see [docker.md](docker.md) and set `TALON_FRONTEND=native`
instead of a bot token. For TrueNAS, see [truenas.md](truenas.md).

## 2. Sign in to a backend

As the user that will run Talon, install and sign in to the agent CLI you
want (see [backends.md](backends.md)). For Claude:

```bash
claude auth login
```

## 3. Configure

Write `~/.talon/config.json`:

```json
{
  "frontend": "native",
  "backend": "claude",
  "native": { "host": "0.0.0.0", "port": 19880 }
}
```

`"frontend": "native"` is what makes it server-only: no Telegram, Discord or
WhatsApp is started, and none of their settings are required. (`talon setup`
works too: pick **Native**, then change `host` to `0.0.0.0`.)

Because the bridge listens beyond loopback, it secures itself on first
start:

- **Token.** It mints a bearer token at `~/.talon/keys/bridge-token`. Every
  client needs it. Set `"token"` in the `native` section to choose your own,
  but make it random (`openssl rand -hex 32`): a token estimated under ~128
  bits (e.g. `hunter2`) stops the bridge from starting on a network bind
  unless you also set `"allowWeakToken": true`.
- **Auth throttling.** Wrong tokens are answered more and more slowly per
  address (250 ms doubling to 8 s after two free misses), 20 in 15 minutes
  locks that address out (`429`), and more than 100 across all addresses in
  5 minutes starts a 10-minute cooldown for unauthenticated traffic and
  alerts the admin chat. Paired clients are never slowed. Every event is
  logged as a `bridge.auth event=…` line.
- **TLS.** It serves HTTPS with a self-signed certificate at
  `~/.talon/keys/bridge-cert.pem`. Clients pin its fingerprint the first
  time they connect.

If other devices reach the server by a different address than the one it
binds (NAT, a hostname, a proxy), set `"publicUrl":
"https://talon.lan:19880"` in `native` so node install links point there.

## 4. Run it as a service

```ini
# /etc/systemd/system/talon.service
[Unit]
Description=Talon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/bin/env talon run
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now talon
talon status                 # as youruser
```

`User=` must be the account whose `~/.talon` and backend sign-in you set up
above. `talon run` stays in the foreground, which is what systemd expects
(`talon start` would fork away from it).

Open the port on the firewall:

```bash
sudo firewall-cmd --permanent --add-port=19880/tcp && sudo firewall-cmd --reload   # Fedora / RHEL
sudo ufw allow 19880/tcp                                                           # Ubuntu
```

## 5. Connect

**Companion app.** Choose **Remote** and fill in:

- **Host:** the server's address.
- **Port:** 19880, with **TLS** on.
- **Token:** the output of `cat ~/.talon/keys/bridge-token`.

On first connect the app pins the server's certificate. To check it's the
right one, compare the app's pinned fingerprint with:

```bash
openssl x509 -in ~/.talon/keys/bridge-cert.pem -noout -fingerprint -sha256
```

**Other machines (talon-node).** From the companion app, ask Talon for an
install link ("make a node install link for linux amd64") and run the
command it returns on the new machine. Or install it by hand:

```bash
talon-node install --bridge https://<server>:19880 --token <bridge-token> --name my-box
```

See [headless-node.md](headless-node.md).

## Reaching it from outside your network

The token grants the whole bridge API, so don't forward port 19880 on your
router. Use a VPN or tailnet, or put a reverse proxy with client
certificates in front ([mtls.md](mtls.md)).

## Troubleshooting

| Symptom                                                 | Fix                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Telegram frontend requires "botToken"`                 | `frontend` still includes `telegram`. Set it to `"native"`.                                                            |
| App can't reach the server                              | `ss -ltnp \| grep 19880` should show `0.0.0.0:19880`. If it shows `127.0.0.1`, set `native.host`. Check the firewall.  |
| `401` / unauthorized in the app                         | Token mismatch. Re-copy `~/.talon/keys/bridge-token`.                                                                  |
| `429` / too many failed auth attempts                   | That address sent wrong tokens repeatedly. Fix the token, then wait out the lockout (`Retry-After`), or restart Talon. Devices on per-device credentials are not locked out. |
| `Refusing to start the bridge: native.token looks weak` | Remove `native.token` (Talon mints a strong one) or use `openssl rand -hex 32`.                                        |
| App refuses the certificate after a reinstall           | `~/.talon/keys` was regenerated. Reconnect from the connect screen to re-pin, after checking the fingerprint.          |
| Anything else                                           | `talon doctor` and `talon logs`.                                                                                       |
