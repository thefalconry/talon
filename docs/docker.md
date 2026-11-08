# Running Talon in Docker

**On TrueNAS SCALE?** Follow [truenas.md](truenas.md). It's a ten-minute
install from the published image.

## Quick install (any Docker host)

```bash
mkdir -p ~/talon-data
docker run -d --name talon --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -e TALON_BOT_TOKEN=123456:ABC... \
  -e TALON_ADMIN_USER_ID=123456789 \
  -v ~/talon-data:/data \
  ghcr.io/thefalconry/talon:latest
docker exec -it talon claude auth login    # once, for the Claude backend
docker restart talon
```

Then DM your bot. To use the companion app instead of (or as well as)
Telegram, add `-p 19880:19880 -e TALON_BRIDGE_URL=https://<this-host>:19880`,
and see [First boot](#first-boot-configuration) for the rest.

Images are published on every release as `latest` and `X.Y.Z`. For access
from outside your network, put a reverse proxy with client certificates in
front ([mtls.md](mtls.md)).

## What must be persisted

The image runs with `HOME=/data`, and **everything Talon and its backends
keep lives under that one directory**. Mount one host directory, dataset or
named volume at `/data` and an image update loses nothing.

| Path in the container         | What it holds                                                                           | Lost without it                              |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `/data/.talon`                | Config, chat history (`data/talon.db`), memory, workspace, skills, bridge keys, backups | Everything Talon knows                       |
| `/data/.claude`               | Claude sign-in **and every Claude conversation transcript** (`projects/`)               | Every Claude chat's context; a fresh sign-in |
| `/data/.claude.json`          | Claude Code account and onboarding state                                                | A re-onboarding on the next start            |
| `/data/.codex`                | Codex sign-in and sessions                                                              | Every Codex chat's context                   |
| `/data/.local/share/opencode` | OpenCode session database                                                               | Every OpenCode chat's context                |
| `/data/.local/share/kilo`     | Kilo session database                                                                   | Every Kilo chat's context                    |
| `/data/.gemini`               | Antigravity (`agy`) sign-in, conversations, and the MCP config Talon writes             | Every agy chat's context; a fresh sign-in    |

Why the backend directories matter as much as `.talon`: Talon's database
records _which_ session each chat is on, but the conversation itself (the
transcript the backend resumes from) is stored by the backend, in its own
directory. Keep `.talon` and lose `.claude` and every chat still points at
a session that no longer exists.

**Map the whole of `/data`, not just `/data/.talon`.** NAS "custom app"
screens (TrueNAS, Unraid, Synology) tempt you into mapping only the path you
recognise. Anything not on a mapped path sits in the container's own
filesystem, and the next image update deletes it without a word.

On a GUI (Unraid's _Add Container_, Synology Container Manager, Portainer)
that means one path mapping: container path `/data`, host path e.g.
`/mnt/user/appdata/talon`. You don't need a `HOME` variable, since `/data` is
the image default. Don't add separate mappings for `.talon` or `.claude`
inside it.

Talon checks this for you. At boot inside a container it works out which
mount each path in the table is on (from `/proc/self/mountinfo`). If a store
for a backend you use is on the container's own filesystem, a tmpfs, or an
anonymous Docker volume (deleted with the container), it sends **one admin
alert** listing each path and this fix. The log gets the same text. Set
`TALON_STORAGE_CHECK=0` to switch the check off.

## Building it yourself

The root `Dockerfile` builds the production image and `docker-compose.yml`
runs it. The image runs as UID 1000 with `HOME=/data`, and compose mounts one
host directory there (`$TALON_DATA_DIR`, default `~/talon-data`):

```bash
mkdir -p ~/talon-data          # before the first `up`, or Docker creates it as root
docker compose up -d --build
docker compose logs -f talon
```

See [`packaging/README.md`](../packaging/README.md#docker-image) for how the
image itself is built.

## Upgrading from the old layout

Images before this change used `HOME=/home/bun` and two mounts:

```text
-v ~/.talon:/home/bun/.talon  -v ~/.claude:/home/bun/.claude
```

That layout never persisted `~/.claude.json`, `~/.codex` or the
OpenCode/Kilo databases. A setup that mapped only `.talon` also lost every
Claude transcript on each update.

**Nothing breaks if you do nothing.** When a container starts with Talon
data at `/home/bun/.talon` and none at `/data/.talon`, the entrypoint keeps
the old layout (`HOME=/home/bun`, same paths) and prints a migration note to
the container log. The boot check then alerts about whichever stores that
layout leaves unpersisted. Nothing is moved, copied or deleted for you.

To move to the single data root:

1. **Take a backup** (`/backup now`, or copy the host directories).
2. **Stop the container** (`docker compose down`, or stop the app).
3. **Copy everything into one directory**, keeping ownership:

   ```bash
   mkdir -p ~/talon-data
   cp -a ~/.talon  ~/talon-data/.talon
   cp -a ~/.claude ~/talon-data/.claude
   # only if you have them:
   cp -a ~/.claude.json ~/talon-data/   2>/dev/null || true
   cp -a ~/.codex  ~/talon-data/.codex  2>/dev/null || true
   cp -a ~/.gemini ~/talon-data/.gemini 2>/dev/null || true
   ```

   Use the host paths your old mounts pointed at. They may be shared with a
   Claude or Codex install on the host itself, and that is why this step
   copies rather than moves.

4. **Point the container at it**: one volume `~/talon-data:/data` (the new
   `docker-compose.yml` does this), and remove the `/home/bun/...` mounts and
   any `HOME` override.
5. **Start it.** On the first boot Talon notices that its home moved from
   `/home/bun/.talon` to `/data/.talon` and re-links your Claude transcripts
   (next section), so every chat resumes where it was.

Once everything checks out, the old host directories are yours to archive
or delete.

### Why the move needs a re-link, and what Talon does

Claude Code files each transcript under `~/.claude/projects/<slug>/`, where
the slug is the session's working directory with every non-alphanumeric
character turned into `-`. Talon's working directory is
`<Talon home>/workspace`, so moving the home changes the slug:

| Talon home         | Claude project directory     |
| ------------------ | ---------------------------- |
| `/home/bun/.talon` | `-home-bun--talon-workspace` |
| `/data/.talon`     | `-data--talon-workspace`     |

Without help, every stored Claude session would point at a transcript Claude
can no longer find. So at every boot Talon compares its home with the one it
recorded last time (in `.talon/data/claude-relink.json`, which travels with a
copied `.talon`). Inside a container it also checks the image's known homes
(`/home/bun/.talon`, `/data/.talon`). It then **copies** the transcripts from
the old project directories (the workspace, `agent-workspace` and any
subdirectory) into the new ones. It never overwrites a file that already
exists, and never moves or deletes the old directories. The log line reads
`Talon home moved: copied N Claude transcript file(s) from … to …`. A copy
that fails is retried on the next boot. The same happens outside Docker when
you change `TALON_HOME`.

## First-boot configuration

If `~/.talon/config.json` doesn't exist when the container starts, the
entrypoint writes one from these variables. It never overwrites an existing
file: after the first boot, edit the config (or use `/settings` or the
companion app).

| Variable              | Becomes                             | Notes                                                                     |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `TALON_FRONTEND`      | `frontend`                          | Comma list allowed. Default: `telegram` with a bot token, else `native`.  |
| `TALON_BOT_TOKEN`     | `botToken`                          | Telegram.                                                                 |
| `TALON_ADMIN_USER_ID` | `adminUserId`, `allowedUsers: [id]` | Required with Telegram. A fresh bot answers only its admin.               |
| `TALON_BACKEND`       | `backend`                           | `claude`, `agy`, `codex`, `kilo`, `opencode`, `openai-agents`.            |
| `TALON_MODEL`         | `model`                             |                                                                           |
| `TALON_BRIDGE_PORT`   | `native.port`                       | Default `19880`.                                                          |
| `TALON_BRIDGE_URL`    | `native.publicUrl`                  | What devices dial. Pairing links need it inside a container.              |
| `TALON_BRIDGE_TOKEN`  | `native.token`                      | Auto-minted if unset. Your own must be ≥128 bits: `openssl rand -hex 32`. |

**Remove the secrets from the container definition after the first boot.**
`TALON_BOT_TOKEN` and `TALON_BRIDGE_TOKEN` are only read once, to seed
`config.json`. Left in place, they stay visible to anyone who can run
`docker inspect` or read `/proc/<pid>/environ`, and in compose files or
appliance UIs, long after Talon has stopped using them. Delete the `-e`
flags (or compose/appliance entries) once `~/.talon/config.json` exists, and
recreate the container. Rotating the token later means editing
`config.json`, not the environment.

The gateway on port 19876 binds `127.0.0.1` inside the container and serves
only the healthcheck and the in-container CLI. The image doesn't `EXPOSE` it,
and there's no reason to publish it.

When `native` is among the frontends, the bridge binds `0.0.0.0` (loopback
is unreachable from outside a container). That turns on TLS and a bearer
token automatically.

## Running as another user

The image runs as UID 1000 by default but works under any UID, e.g.
`--user 568:568` on TrueNAS. `/data` (and the old layout's `/home/bun`) and
the directories inside it are world-writable in the image, and state goes
into your mount. The entrypoint warns if the mount isn't writable by the
container's user, which is the usual cause of permission errors: create the
host directory before the first start and give it to that UID.

## Antigravity (`agy`) backend

The image ships the tools agy shells out to (`git`, `ripgrep`). Two things
have to come from you: the `agy` binary (there is no npm package to install
it from) and a one-time Google sign-in (there is no API key).

### 1. Provide the binary

Pick one:

- **Bind-mount the host's binary** (the default in `docker-compose.agy.yml`).
  If `agy` isn't at `/usr/local/bin/agy` on the host, point at it:

  ```bash
  export AGY_BINARY_HOST="$(command -v agy)"
  ```

- **Bake it into the image.** Pass the URL of the Linux binary for your
  architecture and its SHA-256. The build verifies the digest and fails on a
  mismatch:

  ```bash
  AGY_DOWNLOAD_URL=https://…/agy-linux-amd64 \
  AGY_SHA256=<sha256> \
  docker compose -f docker-compose.yml -f docker-compose.agy.yml build
  ```

  Then delete the `/usr/local/bin/agy` mount line from
  `docker-compose.agy.yml`, because a mount there would hide the baked copy.

Either way the binary ends up at `/usr/local/bin/agy`, which is on `PATH`,
so no `agyBinary` / `AGY_BINARY` setting is needed.

### 2. Sign in once

agy caches its OAuth token at
`~/.gemini/antigravity-cli/antigravity-oauth-token`, and headless runs reuse
it. Inside the container that is `/data/.gemini/…`. The compose override
additionally mounts the host's `~/.gemini` there (drop that line to keep
agy's state in the data directory only), so:

- **Signed in on the host already?** Nothing to do. The container reuses the
  cache.
- **No browser on the host?** Sign in with `agy` on any desktop, then copy
  `~/.gemini/antigravity-cli/antigravity-oauth-token` into
  `.gemini/antigravity-cli/` in the data directory (or the host `~/.gemini`
  you mount) on the Docker host (owner UID 1000, mode `0600`).
- **Or try it in the container:** `docker compose exec -it talon agy`. If the
  CLI prints a sign-in URL you can open elsewhere, finish there. If it can
  only open a local browser, use the copy route above.

### 3. Run it

```bash
docker compose -f docker-compose.yml -f docker-compose.agy.yml up -d --build
```

and set `"backend": "agy"` in `~/.talon/config.json`, or switch per chat with
`/model`. `docker compose exec talon bun src/cli.ts doctor` (or
`node --import tsx src/cli.ts doctor` on the Node image) checks the binary,
its version, the cached sign-in and the model list.

`~/.gemini/config/mcp_config.json` is **shared** with any agy you run on the
host. Talon only writes keys under its own `__talon__` prefix and preserves
everything else. But a Talon on the host and one in the container, both on
agy, prune each other's entries at startup. See
[`docker/agy-test/README.md`](../docker/agy-test/README.md#coexistence-with-production).
