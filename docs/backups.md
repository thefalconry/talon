# Backups, restore and cloning

A snapshot is meant to be the whole bot: restore it on the same machine and
Talon comes back 1:1, or restore it with `--clone` on a fresh machine and you
get the same agent there. It holds every chat, every session transcript,
memory, skills, keys and plugins. It leaves out machine bulk that can be
fetched or rebuilt (uploads, media, build output, venvs, node_modules).

Snapshots live in `~/.talon/backups/<id>/`. Each one is a `manifest.json`
plus up to three parts (zstd tar, and AES-256-GCM encrypted when
`backup.encryption` is set; the name then ends in `.enc`):

| Part                    | Holds                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.tar.zst`         | the Talon home (config, prompts, keys, data/, mesh, google/, plugins/), the workspace subset, plugin checkouts, `plugins-manifest.json`, and `db/talon.db` |
| `sessions.tar.zst`      | backend session transcripts and session databases, plus `data/traces/`                                                                                     |
| `palace-<hash>.tar.zst` | the memory palace, content-addressed (reused while unchanged)                                                                                              |

## What is captured

| Item                 | Path                                                                                                                           | Notes                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database             | `~/.talon/data/talon.db`                                                                                                       | copied by SQLite (`VACUUM INTO`), never byte-wise; the live `-wal`/`-shm` are excluded                                                                        |
| Config, prompts      | `config.json`, `prompts/`                                                                                                      |                                                                                                                                                               |
| Keys                 | `keys/`, `google/`, `.user-session`, `whatsapp-auth/`                                                                          |                                                                                                                                                               |
| Mesh                 | `mesh-devices.json`, `mesh-history.json`, `mesh-locations.json`, `teleport-state.json`                                         |                                                                                                                                                               |
| Legacy/state JSON    | `data/*`                                                                                                                       | goals, cron and triggers live in talon.db; `data/trigger-runs/` comes along                                                                                   |
| Agent workspace      | `agent-workspace/`                                                                                                             |                                                                                                                                                               |
| Workspace            | `identity.md`, `memory.md`, `state.md`, `heartbeat-instructions.md`, `memory/`, `skills/`, `scripts/`, `stickers/`, `secrets/` | set by `backup.workspaceInclude`                                                                                                                              |
| Palace               | `workspace/palace/`                                                                                                            | own part; `backup.includePalace`                                                                                                                              |
| Claude sessions      | `~/.claude/projects/<slug>/` for the workspace and `agent-workspace/` (subdirectories included)                                | `$CLAUDE_CONFIG_DIR` is honoured                                                                                                                              |
| Codex sessions       | `$CODEX_HOME/sessions/` (default `~/.codex`)                                                                                   | only when `codex` is an enabled backend                                                                                                                       |
| OpenCode / Kilo      | `$XDG_DATA_HOME/{opencode,kilo}/storage/` and `opencode.db` / `kilo.db`                                                        | the databases go through SQLite, same as talon.db                                                                                                             |
| Antigravity          | `~/.gemini/antigravity-cli/{conversations,brain,annotations,implicit}`, `conversation_summaries.db`                            | only when `agy` is enabled                                                                                                                                    |
| Traces               | `data/traces/`                                                                                                                 | sessions part                                                                                                                                                 |
| Plugins (installed)  | `~/.talon/plugins/`                                                                                                            | package.json and lockfile; node_modules is reinstalled                                                                                                        |
| Plugins (local path) | each `plugins[].path` in config.json                                                                                           | archived as `plugin-src/<n>-<name>/` from the package root. node_modules, `.venv`, `dist/`, `build/` and caches are left out; lockfiles are kept              |
| Plugins (fetched)    | `npx`/`bunx`/`uvx`/`docker` entries                                                                                            | written to `plugins-manifest.json` as package@version or image:tag. An unpinned npm package gets the version from the local npx cache, marked `pinned: false` |

Never captured: `talon.log*`, `errors.log`, `backups/`, `ns/` (a FUSE mount,
never stat()ed), `node-bin/`, virtualenvs and node_modules anywhere,
`*.tmp-*`, `native-bridge.json` (rewritten on every boot), and the backup
passphrase file itself. Backend logins (`~/.claude/.credentials.json`,
`~/.codex/auth.json`, `~/.gemini/.../antigravity-oauth-token`) are not
captured either. They are per-machine OAuth grants; log in again on a clone.

### Size and exclusions

The workspace uses an allow-list: only `backup.workspaceInclude` goes in. By
default that leaves out everything else in it, such as `media/`, `uploads/`,
`builds/`, `projects/`, `logs/` and `docs/`. To carry more, add entries (an exact
path or `dir/**`):

```json
"backup": { "workspaceInclude": ["identity.md", "memory/**", "skills/**", "notes/**"] }
```

The sessions part is usually the largest part. Set
`"backup": { "includeSessions": false }` to leave transcripts and traces out.
Chats then restore to session ids that have no transcript behind them.

`secrets/` is included. When encryption is on it is protected like
everything else. When it is off, the snapshot stays local: remote targets
refuse plaintext parts.

## Restoring on the same machine

```sh
talon stop
talon backup restore <id>            # add --from <target> to fetch missing parts
talon start
```

A pinned `pre-restore <id>` checkpoint is taken first, so a restore can be
undone. Each covered root, including every session store, is brought back to
exactly the snapshot's contents. Files created after the snapshot move into
that checkpoint. A snapshot taken under a different user home is refused
unless you pass `--clone`.

From chat, the admin's `/backup` opens a panel (Telegram and Discord): the
schedule, the last run and any failing streak, local size and pins,
retention, encryption and each target's readiness, with buttons to back up
now, browse snapshots (pin, unpin, restore), read how restore works, and
refresh. A snapshot's Restore button only opens a confirmation; the
confirmed restore is staged to `~/.talon/restore-pending.json`, Talon
restarts, and the next boot applies it before the database opens. Chat
restores use the local copy — fetch a remote-only snapshot with the CLI.

## Cloning onto a new machine

1. Install Talon on the new machine (docs/server-install.md). Don't start it.
2. Copy the snapshot directory to `~/.talon/backups/<id>/` on the new
   machine, or register the same remote target and use `--from`.
3. Provide the passphrase if the snapshot is encrypted:
   `export TALON_BACKUP_PASSPHRASE=...`, or copy the key file to the path in
   `backup.encryption.passphraseFile`.
4. Restore with relocation:

   ```sh
   talon backup restore <id> --clone
   ```

   `--clone` moves each session store and plugin checkout from the old user
   home to this one. It renames Claude project directories so the new
   workspace path finds its transcripts. It also rewrites the absolute paths
   in `config.json`, such as plugin paths and the passphrase file.

5. Reinstall plugins from `~/.talon/plugins-manifest.json`:
   - `local` entries: run `npm ci` (or `uv sync`) in each restored checkout.
   - `~/.talon/plugins/`: `npm ci --prefix ~/.talon/plugins`.
   - `npm` entries: pinned specs run as-is. For unpinned ones, pin the
     recorded `version` in config.json if you want the exact same build.
   - `python` / `docker` entries: pull or install the recorded spec or image.
6. Log the backends in again (`claude login`, `codex login`, …).
7. Mesh: the bridge keys (`keys/bridge-*.pem`) come along, so paired devices
   still trust the certificate. If the new machine has a different
   address, point the devices at it again, or re-pair them
   (docs/mesh-pairing.md). Headless nodes that were registered by host id
   show up as new devices; remove the old entries with `remove_device`.
8. `talon start`.

Limitation: talon.db records saved scripts and triggers by absolute path.
`--clone` does not rewrite the database, so a clone whose Talon home is at a
different path (a different user name, say) keeps those rows pointing at the
old location. The files themselves are restored. The simplest fix is to use
the same user name on the new machine. Otherwise, save the affected scripts
again.
