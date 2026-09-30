# Packaging

Distribution artefacts for installing Talon outside the development tree.

## Contents

| Path                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `systemd/talon.service`         | Linux systemd unit for a source-checkout daemon run.     |
| `systemd/talon-package.service` | Linux systemd unit for an npm install (`talon` on PATH). |

The Dockerfile / Docker Compose configuration lives at the repository
root for convention (`docker compose up -d` from the checkout). The
`docker/` directory holds auxiliary harnesses (e.g. `docker/kilo-test/`
for backend-specific test bots), not the primary production image.

## Docker image

The production image runs the daemon on Bun — `CMD ["bun", "src/index.ts"]`,
the same entry as `npm start`, with no tsx loader in the picture.

```sh
docker build -t talon .                          # Bun (default)
docker build --build-arg RUNTIME=node -t talon . # Node 24 + tsx fallback
```

`RUNTIME` selects between two base stages in the one Dockerfile
(`oven/bun:1` and `node:24-slim`); each carries its own `CMD` and
healthcheck probe and the final stage inherits whichever was chosen. The
Node variant is a fallback for one release cycle (see
[`docs/ts-migration-plan.md`](../docs/ts-migration-plan.md), Phase 1) and
is expected to go away with it.

Notes on the build:

- **Dependencies are installed by npm, in a `node:24-slim` builder stage,
  for both variants.** `package-lock.json` is this repo's lockfile of
  record (CI's Lockfile Portability job gates on it) and `bun install`
  cannot read it — there is no `bun.lock` to install from. `npm ci
--omit=dev` reproduces the tree exactly, runs the postinstalls that
  unpack native artefacts, and selects the `os`/`cpu`-matching optional
  deps for the build platform; the runtime stage just copies
  `node_modules` in. Multi-arch builds work because buildx runs the
  builder stage natively per target (linux/amd64, linux/arm64).
- **`claude` on PATH is the Agent SDK's own binary, symlinked.** The SDK
  ships the full Claude Code CLI as a per-platform optional dep
  (`@anthropic-ai/claude-agent-sdk-linux-x64` and friends), so the image
  links that onto `/usr/local/bin/claude` instead of installing
  `@anthropic-ai/claude-code` globally a second time — same binary, one
  copy (~220 MB saved), and its version can never drift from the SDK's.
  A `claude` on PATH is still required: `talon doctor` checks for it,
  `talon login claude` spawns `claude auth login`, and that is also the
  in-container OAuth bootstrap documented in `docker-compose.yml`.
- **The musl SDK variant is pruned** (`rm -rf
…claude-agent-sdk-linux-*-musl`). Modern npm honours the packages'
  `libc` field and skips it on a glibc host, so this is usually a no-op,
  but it keeps an older npm from leaving a musl binary that the SDK
  probes first and fails to exec on Debian. Invert it if the runtime is
  ever rebased onto Alpine.
- **`HOME=/data` in both variants: one data root.** `~/.talon` and every
  backend's sign-in and session store (`~/.claude`, `~/.claude.json`,
  `~/.codex`, `~/.gemini`, `~/.local/share/{opencode,kilo}`) live under it,
  so a single volume at `/data` persists all of it and `VOLUME /data` is the
  only one declared. Both base images ship an unprivileged UID 1000
  (`bun` / `node`), which is the user the daemon runs as. The image sets
  `TALON_CONTAINER=1`, which turns on the daemon's boot-time check that
  those stores are on a persistent mount (`src/core/layout/`).
- **Entrypoint: `docker/entrypoint.sh`.** It keeps a container that
  still has the old layout's data at `/home/bun/.talon` (and nothing at
  `/data/.talon`) on `HOME=/home/bun`, with a migration note in the log. It
  checks that `HOME` and the state mounts are writable, and on first boot runs
  `docker/seed-config.mjs` to write `~/.talon/config.json` from `TALON_*`
  env vars. It never overwrites an existing config. `ENTRYPOINT` is declared
  in each base stage, because declaring it in the runtime stage would reset
  the per-runtime `CMD`. The image runs under any UID (`HOME` is
  world-writable, and TrueNAS's `apps`/568 has a passwd entry). CI
  smoke-tests exactly that path. Guides: [`docs/docker.md`](../docs/docker.md),
  [`docs/truenas.md`](../docs/truenas.md).
- **Agent CLI tooling is in the runtime stage.** `git` and `ripgrep`
  are installed because the Antigravity `agy` CLI shells out to them, and
  Claude Code uses them when present. `agy` itself isn't on npm, so the
  image takes it either baked in at build time (`--build-arg
AGY_DOWNLOAD_URL=… --build-arg AGY_SHA256=…`, digest-checked) or
  bind-mounted at `/usr/local/bin/agy` at run time
  (`docker-compose.agy.yml`). `~/.gemini` is pre-created, owned by UID 1000,
  so a fresh named volume mounted there is writable. See
  [`docs/docker.md`](../docs/docker.md#antigravity-agy-backend).

## Native launcher (`talon-driver`)

The binary distribution channels — an apt `.deb`, a Homebrew bottle, a
source install — ship the compiled launcher
([`native/talon-driver`](../native/talon-driver/)) as the `talon` entry
point instead of the npm `bin/talon.js` shim. It is a small native
per-arch executable that locates a Node >= 24 and execs `bin/talon.js`,
so packages don't depend on a particular Node being first on `PATH`.

Build the per-arch artefacts for packaging:

```sh
npm run build:driver:all   # x86_64/aarch64 × linux-musl/macos → native/talon-driver/dist/
```

A `.deb` or bottle that vendors its own Node can drop it at
`<prefix>/vendor/node` next to the launcher and it is picked up before
any system Node (full resolution order is in the driver's README). The
npm package is unchanged — it keeps shipping the portable
`bin/talon.js`, which works on every platform including Windows.

## Supervision harness (`talon-warden`)

The same channels should ship the Rust trigger-supervision harness
([`native/talon-warden`](../native/talon-warden/)) as
`bin/talon-warden` beside `bin/talon.js` (or anywhere, with
`TALON_WARDEN=<path>` set in the service environment). It is optional:
without it the trigger supervisor uses its in-process TS path; with it
trigger children get own-process-group kills, out-of-process timeouts,
and orphan-free teardown. Build per arch on a matching-OS builder:

```sh
npm run build:warden                                       # host arch → bin/talon-warden
node native/talon-warden/build.mjs --target=<rust-triple>  # cross (Linux targets) → dist/
```

## Hashing addon (`talon-blake3.node`)

Optional like the warden: ship
([`native/blake3-napi`](../native/blake3-napi/)) as
`bin/talon-blake3.node` (override: `TALON_BLAKE3_NODE`) and media
hashing runs on native SIMD off the event loop; without it the embedded
wasm module does the hashing. Build per arch the same way:

```sh
npm run build:napi                                        # host arch → bin/talon-blake3.node
node native/blake3-napi/build.mjs --target=<rust-triple>  # cross (Linux targets) → dist/
```

## Namespace FUSE addon (`talon-fusefs.node`)

Optional and Linux-only: ship
([`native/talon-fusefs`](../native/talon-fusefs/)) as
`bin/talon-fusefs.node` (override: `TALON_FUSEFS_NODE`) and the daemon
mounts the talon:// namespace at `~/.talon/ns` with live `proc/` and
`plugins/` views; without it the namespace is the plain symlink farm.
Build per arch the same way:

```sh
npm run build:fusefs                                        # host arch → bin/talon-fusefs.node
node native/talon-fusefs/build.mjs --target=<rust-triple>   # cross (Linux targets) → dist/
```
