# syntax=docker/dockerfile:1

# Talon's production image. The daemon runs on Bun (`bun src/index.ts` —
# the same entry `npm start` uses); `--build-arg RUNTIME=node` selects a
# node:24 + tsx base instead, kept as a fallback for one release cycle
# (docs/ts-migration-plan.md, Phase 1).
ARG RUNTIME=bun

# ── deps ──────────────────────────────────────────────────────────────
# node_modules is materialised by npm, not bun, in both variants: npm is
# this repo's lockfile of record (CI's "Lockfile Portability" job gates
# on package-lock.json and no bun.lock is checked in), and `bun install`
# cannot read package-lock.json. npm ci resolves the tree byte-for-byte
# per the lockfile, runs the postinstalls that unpack native artefacts,
# and picks the os/cpu-matching optional deps for whatever platform the
# build runs on (linux/amd64 and linux/arm64 both work — buildx runs
# this stage natively per target). Bun needs nothing installed at
# runtime; it just resolves the tree npm produced.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Claude Agent SDK publishes its native `claude` CLI as one optional
# dep per platform, including linux-<arch>-musl (Alpine) next to
# linux-<arch> (glibc), and probes musl first. Modern npm honours the
# packages' `libc` field and skips the musl variant on a glibc host, so
# this is usually a no-op — but it is cheap insurance against an npm
# without libc filtering, where the SDK would spawn a musl binary on
# Debian and Talon would die at startup with "native binary not found".
# It also keeps the glob below unambiguous. (Invert it if you ever
# rebase the runtime onto alpine.)
RUN rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

# ── runtime bases ─────────────────────────────────────────────────────
# Two interchangeable bases; the ARG above picks one. Everything that
# differs between the runtimes (interpreter, CMD, healthcheck probe)
# lives here and is inherited by the final stage — the rest of the build
# is runtime-agnostic.
#
# HOME is /data in *both*: one data root holding everything that must
# outlive the container — ~/.talon, and every backend's sign-in and
# session store (~/.claude, ~/.claude.json, ~/.codex, ~/.gemini,
# ~/.local/share/{opencode,kilo}). Mount one volume at /data and nothing
# is left on the image's writable layer. Images before this one used
# HOME=/home/bun with separate mounts; the entrypoint still recognises
# that layout (docker/entrypoint.sh) and docs/docker.md covers moving off
# it. Both base images ship an unprivileged UID 1000 (`bun` / `node`),
# which is what the app runs as by default — any other UID works too (see
# the HOME permissions below). TALON_CONTAINER tells the daemon it runs
# here, which turns on its boot-time persistence check.
#
# ENTRYPOINT is set here rather than in the runtime stage on purpose:
# declaring an ENTRYPOINT in a stage resets the CMD it inherited, and the
# CMD is what differs per runtime.

FROM oven/bun:1 AS base-bun
ENV TALON_RUNTIME=bun HOME=/data TALON_CONTAINER=1
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["bun", "src/index.ts"]

FROM node:24-slim AS base-node
ENV TALON_RUNTIME=node HOME=/data TALON_CONTAINER=1
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:19876/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]

# ── runtime ───────────────────────────────────────────────────────────
FROM base-${RUNTIME} AS runtime
WORKDIR /app

# Tools the agent CLIs shell out to for their built-in tools: the
# Antigravity `agy` backend needs git + ripgrep on PATH (docker/agy-test
# carries the same set), and the Claude Code CLI uses them too when
# present. ca-certificates keeps outbound HTTPS working on both bases;
# curl is here for the optional agy download below. zip/unzip are here
# because both slim bases ship tar and gzip but not them, so an agent asked
# to pack or unpack a .zip falls back to writing a Python zipfile script on
# every call — slower, more tokens, and more places to get it wrong.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl git ripgrep unzip zip \
  && rm -rf /var/lib/apt/lists/*

# Antigravity CLI (`backend: "agy"`). Google ships it as a standalone
# binary, not an npm package, so there is nothing for `npm ci` to pull.
# Two ways in, both landing at /usr/local/bin/agy (on PATH, which is where
# the backend looks by default):
#   1. Bake it in:  --build-arg AGY_DOWNLOAD_URL=<url of the linux binary
#      for this platform> --build-arg AGY_SHA256=<its sha256>. Both are
#      required: a missing or mismatched digest fails the build, because
#      an unverified binary would run with the agent's credentials.
#   2. Bind-mount a host binary at run time — docker-compose.agy.yml.
# Either way the OAuth sign-in lives in ~/.gemini, mounted at run time
# (see docker-compose.agy.yml and docs/docker.md).
ARG AGY_DOWNLOAD_URL=""
ARG AGY_SHA256=""
RUN set -eu; \
  if [ -n "$AGY_DOWNLOAD_URL" ]; then \
    if [ -z "$AGY_SHA256" ]; then \
      echo "ERROR: AGY_DOWNLOAD_URL is set but AGY_SHA256 is not — refusing an unverified binary" >&2; \
      exit 1; \
    fi; \
    curl -fsSL "$AGY_DOWNLOAD_URL" -o /tmp/agy; \
    echo "$AGY_SHA256  /tmp/agy" | sha256sum -c -; \
    install -m 0755 /tmp/agy /usr/local/bin/agy; \
    rm -f /tmp/agy; \
  fi

COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules

# package.json is required at runtime, not just for the install: its
# `imports` map routes #prompt-assets to the embedded prompts under Bun
# and to the on-disk ones under Node.
COPY --chown=1000:1000 package.json tsconfig.json ./
COPY --chown=1000:1000 src/ src/
COPY --chown=1000:1000 prompts/ prompts/
COPY --chown=1000:1000 bin/ bin/
# Entrypoint + first-boot config seeding (TALON_* env → config.json).
COPY --chown=1000:1000 --chmod=0755 docker/entrypoint.sh docker/seed-config.mjs docker/

# `talon doctor`, `talon login claude`, and the interactive
# `claude auth login` bootstrap documented in docker-compose.yml all want
# a `claude` on PATH. The Agent SDK already ships that exact binary (the
# full Claude Code CLI, version-matched to the SDK), so link it instead
# of installing @anthropic-ai/claude-code globally a second time — the
# binary is ~220 MB, and the global install is also npm-only, which the
# bun base image has no use for.
RUN set -eux; \
  claude_bin="$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -n1)"; \
  ln -sf "$claude_bin" /usr/local/bin/claude; \
  for home in /data /home/bun; do \
    mkdir -p "$home/.talon" "$home/.claude" "$home/.gemini"; \
    chown -R 1000:1000 "$home"; \
    chmod 0777 "$home" "$home/.talon" "$home/.claude" "$home/.gemini"; \
  done

# /home/bun is created too, so a container still started with the old
# layout's mounts (/home/bun/.talon, /home/bun/.claude) keeps working.
#
# Arbitrary-UID support. NAS appliances run containers as their own app
# user (TrueNAS: `user: "568:568"`, owner of the app's datasets), not as
# the image's 1000. Everything persistent is bind-mounted and owned by that
# user already, but some state lands directly in HOME (Claude Code's
# ~/.claude.json, runtime caches), so HOME and the mount points are world-
# writable. It's a single-user container, so that opens nothing. Talon
# still locks its own files to 0600/0700 once it runs.
#
# TrueNAS's `apps` user (568) also gets a passwd entry: git and ssh look
# the current user up and refuse to work for a UID that has none.
RUN groupadd -g 568 apps \
  && useradd -u 568 -g 568 -d /data -M -s /bin/sh apps

USER 1000:1000

# All persistent state lives under /data (HOME). Bind-mount a host
# directory or a named volume there; without one Docker creates an
# anonymous volume, which is lost when the container is removed (the
# daemon alerts about that at boot). See docs/docker.md.
VOLUME /data

# 19880: native bridge (companion app, nodes). The gateway (19876) binds
# 127.0.0.1 inside the container and only serves the in-container
# HEALTHCHECK and CLI — publishing it would expose nothing, so it is not
# declared.
EXPOSE 19880

# CMD and HEALTHCHECK are inherited from the selected base stage.
