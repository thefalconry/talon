#!/bin/sh
# Talon container entrypoint.
#
# Runs as whatever user the container was started with — UID 1000 by
# default, or e.g. `user: "568:568"` on TrueNAS, where apps run as the
# `apps` user and own their datasets. It never needs root.
set -eu

# ── Layout: one data root (HOME=/data), or the old /home/bun mounts ──
#
# Older images ran with HOME=/home/bun and asked for two mounts,
# /home/bun/.talon and /home/bun/.claude. This image keeps everything
# under HOME=/data. A container recreated from an old definition still
# has its data at /home/bun/.talon and an empty /data, so switching it
# silently would look like a factory reset. Instead: when the Talon home
# under HOME is empty and the old one holds a Talon install, keep running
# on the old layout — same paths, same Claude project slug — and say how
# to move. Nothing is moved, copied or deleted here.
LEGACY_HOME=/home/bun
has_talon() {
  [ -e "$1/.talon/config.json" ] || [ -e "$1/.talon/data/talon.db" ]
}
if [ -z "${TALON_HOME:-}" ] && [ "$HOME" != "$LEGACY_HOME" ]; then
  if has_talon "$LEGACY_HOME" && ! has_talon "$HOME"; then
    cat >&2 <<EOF_LEGACY
[entrypoint] NOTE: found Talon data at $LEGACY_HOME/.talon and none at $HOME/.talon.
[entrypoint]   Running on the old layout (HOME=$LEGACY_HOME) so nothing changes for you.
[entrypoint]   On this layout only the paths you mounted survive an image update;
[entrypoint]   ~/.claude.json, ~/.codex and the OpenCode/Kilo stores usually don't.
[entrypoint]   To move to the single data root: stop the container, copy .talon and
[entrypoint]   .claude (plus any .codex, .gemini, .claude.json) into one directory,
[entrypoint]   mount it at /data, and drop the /home/bun mounts. Talon re-links the
[entrypoint]   Claude transcripts to the new path on its first boot there.
[entrypoint]   Guide: docs/docker.md, "Upgrading from the old layout". Nothing was moved.
EOF_LEGACY
    HOME=$LEGACY_HOME
    TALON_LAYOUT=legacy
    export HOME TALON_LAYOUT
  elif has_talon "$LEGACY_HOME" && has_talon "$HOME"; then
    echo "[entrypoint] WARNING: Talon data exists at both $LEGACY_HOME/.talon and $HOME/.talon — using $HOME. Remove the old /home/bun mounts once you have checked nothing is missing." >&2
  fi
fi

# A HOME we can't write means Claude Code can't keep ~/.claude.json and
# Talon can't create ~/.talon. The image makes /data world-writable for
# exactly this case; if someone mounted over it read-only, say so up front
# instead of failing somewhere deep in a backend.
if [ ! -w "$HOME" ]; then
  echo "[entrypoint] WARNING: HOME ($HOME) is not writable by uid $(id -u) — mount a writable volume there" >&2
fi

for dir in "${TALON_HOME:-$HOME/.talon}" "$HOME/.claude" "$HOME/.gemini"; do
  mkdir -p "$dir" 2>/dev/null || true
  if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    echo "[entrypoint] WARNING: $dir is not writable by uid $(id -u):$(id -g) — fix the host path's owner (TrueNAS: set the dataset owner to the app's user)" >&2
  fi
done

# First boot only: turn TALON_* env vars into ~/.talon/config.json.
"${TALON_RUNTIME:-bun}" /app/docker/seed-config.mjs

exec "$@"
