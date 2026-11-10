# Talon on TrueNAS SCALE — quick install

Talon runs on TrueNAS SCALE 24.10 ("Electric Eel") and later as a custom
app from the published container image. No build step is needed and nothing
is installed on the NAS itself. Plan on about ten minutes.

**What you need:** a TrueNAS SCALE 24.10+ system with a pool, and one of:

- a **Telegram bot token** (from [@BotFather](https://t.me/BotFather)) and
  your numeric Telegram user id (from [@userinfobot](https://t.me/userinfobot)),
- or the **Talon companion app** (desktop or Android) to talk to it over your
  LAN,

plus an account for the AI backend you want. The default is Claude (a Claude
subscription or an Anthropic API key).

## 1. Create a dataset

**Datasets → Add Dataset**

- Parent: your pool's `apps` dataset (create one if you don't have it).
- Name: `talon`
- **Dataset Preset: Apps.** This makes the `apps` user (UID/GID 568) the
  owner, which is the user the container runs as.

Note the path, e.g. `/mnt/tank/apps/talon`. Everything Talon keeps lives
here: config, chat history, workspace, memory, keys, every backend's sign-in,
and every backend's conversation transcripts (`.claude/`, `.claude.json`,
`.codex/`, `.gemini/`, `.local/share/`). Snapshotting this one dataset backs
up all of it.

Map the dataset to `/data` as a whole. If you build the app by hand in the
_Custom App_ screen instead of pasting the YAML, add exactly one storage
entry: host path = the dataset, mount path = `/data`. Mapping only a
`.talon` directory keeps Talon's config but puts every conversation
transcript on the container's own filesystem, and the next update deletes
it. Talon sends an alert at boot when it spots that; see
[docker.md](docker.md#what-must-be-persisted).

## 2. Install the app

**Apps → Discover Apps → ⋮ (top right) → Install via YAML**

- Name: `talon`
- Paste [`packaging/truenas/compose.yaml`](../packaging/truenas/compose.yaml)
  and edit:
  - the volume line: `/mnt/tank/apps/talon` → your dataset path;
  - `TALON_BOT_TOKEN` and `TALON_ADMIN_USER_ID` for Telegram, or leave both
    empty to start with the companion-app bridge only;
  - `TALON_BRIDGE_URL`: the address your phone uses to reach the NAS
    (hostname or IP, port `19880`);
  - `TALON_BACKEND` if you want something other than Claude.

Click **Save**. TrueNAS pulls `ghcr.io/thefalconry/talon` and starts it. On
first boot the container writes `/data/.talon/config.json` from those
variables. After that the file is yours: the variables are ignored from then
on, so later changes go into the file (or through `/settings` in Telegram, or
the companion's settings screen).

> Running from a fork? Its release workflow publishes to
> `ghcr.io/<your-account>/talon` instead. Change the `image:` line to match.

## 3. Sign the backend in (once)

Open a shell in the container: **Apps → talon → Workloads → talon → Shell**
(or from **System → Shell**: `sudo docker exec -it $(sudo docker ps -qf name=talon) sh`).
It runs as the same `apps` user, so anything you create here is owned
correctly.

**Claude (default):**

```sh
claude auth login
```

Open the URL it prints in any browser, sign in, and paste the code back.
Credentials land in `/data/.claude` on your dataset. If you'd rather use an
API key, set `ANTHROPIC_API_KEY` in the app's YAML instead and skip this.

**Antigravity (`TALON_BACKEND: "agy"`):** the `agy` CLI isn't distributed
through npm, so the image can't include it. Put the Linux binary on a dataset
(e.g. `/mnt/tank/apps/talon-bin/agy`, executable) and uncomment the
`/usr/local/bin/agy` volume line in the YAML. agy has no API key: sign in by
running `agy` in the container shell if it offers a URL you can open
elsewhere. Otherwise run it on a desktop and copy
`~/.gemini/antigravity-cli/antigravity-oauth-token` into
`<dataset>/.gemini/antigravity-cli/` (owner `apps`, mode `0600`). More detail
is in [docker.md](docker.md#antigravity-agy-backend).

Then restart the app (**Apps → talon → Restart**).

## 4. Connect

**Telegram:** DM your bot. Only `TALON_ADMIN_USER_ID` is allowed to talk to
it at first. Add more people later under `allowedUsers` in the config.

**Companion app:** the bridge listens on port `19880` over TLS with an
auto-minted token.

- If Telegram is also set up, send `/mesh link` to the bot and open the link
  on your phone. The app configures itself.
- Otherwise, in the app choose **Remote** and enter your NAS address, port
  `19880`, **HTTPS on**, and the token from:

  ```sh
  cat /data/.talon/keys/bridge-token
  ```

  The app pins the bridge's certificate on first connect. The fingerprint is
  in the app logs (**Apps → talon → Logs**) if you want to compare them.

## Checking on it

- **Logs:** Apps → talon → Logs, or `/data/.talon/talon.log` on the dataset.
- **Health:** the image has a built-in healthcheck, and TrueNAS shows the app
  as unhealthy if the daemon stops answering.
- **Diagnostics:** in the container shell, `bun src/cli.ts doctor`.

## Updating

The YAML uses `image: …:latest` with `pull_policy: always`, so **Apps →
talon → Stop → Start** (or editing and saving the app) pulls the newest
release. To control updates yourself, pin a version instead (`:5.5.1`) and
change it when you choose. Your dataset is untouched by updates. Only what's
outside it (a path you didn't map) is lost.

## Optional: reach it from anywhere, certificate-only

The Immich setup. Put your reverse proxy (Caddy, nginx, Traefik, or a
Cloudflare Tunnel) in front of `https://<nas>:19880` and have it require a
client certificate. Then import the certificate in the app, alongside the
usual token. Add the NAS address as **Local network address** too, and the
app will use it whenever you're home. Talon needs no changes for this;
[mtls.md](mtls.md) has the certificate commands and a config for each
proxy. Don't forward port 19880 on your router.

## Troubleshooting

| Symptom                                                                                               | Fix                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log says `… is not writable by uid 568`                                                               | The dataset isn't owned by `apps`. Edit the dataset's permissions and set owner/group to `apps`, or recreate it with the **Apps** preset. A mount path that didn't exist gets created by Docker as `root`.                                                                                                                                                                                            |
| `Telegram frontend requires "botToken"`                                                               | The config was seeded without a token. Add `"botToken"` to `/data/.talon/config.json` and restart. Changing the env var alone does nothing once the file exists.                                                                                                                                                                                                                                      |
| Companion can't connect                                                                               | Check that port `19880` is in the YAML and not used by another app, **HTTPS** is on in the app, and the token matches `/data/.talon/keys/bridge-token`.                                                                                                                                                                                                                                               |
| Pairing link points at a `172.x.x.x` address                                                          | Set `"publicUrl": "https://<nas>:19880"` in the `native` section of the config (that's what `TALON_BRIDGE_URL` seeds) and restart.                                                                                                                                                                                                                                                                    |
| `Client certificate required` in the companion                                                        | Your reverse proxy wants a client certificate: import the device's `.p12` in the app ([mtls.md](mtls.md)), or connect on your home network.                                                                                                                                                                                                                                                           |
| Chats lost their context after an update, or a boot alert says a path is "not on a persistent volume" | Only part of the data was mapped (typically `.talon`). Stop the app, make sure the dataset is mounted at `/data` as a whole, copy any directories you still have from the old mapping into the dataset (`.claude`, `.codex`, …), and start it. See [docker.md](docker.md#upgrading-from-the-old-layout). Transcripts already deleted by an earlier update can only come back from a dataset snapshot. |
| Log says `found Talon data at /home/bun/.talon`                                                       | The app still uses the old two-mount layout. It keeps working; to move to the single dataset, follow [docker.md](docker.md#upgrading-from-the-old-layout).                                                                                                                                                                                                                                            |
| Want to start over                                                                                    | Stop the app, delete `/data/.talon/config.json` (keeps history) or empty the dataset (everything), then start it again.                                                                                                                                                                                                                                                                               |
