# Backup security: encryption, signed manifests, login sessions

Backups are on by default. A snapshot holds everything needed to rebuild
the agent on another machine: `config.json` (bot tokens, API keys),
`keys/` (the bridge key and TLS identity), `secrets/` (what the secret
drop stores), `workspace/secrets`, the
database and memory. So a snapshot must be treated like the credentials
it contains. This page covers what protects it and what you have to do.

## TL;DR for operators

```sh
talon backup keygen                 # writes ~/.talon/backup.key (mode 600)
```

```json
"backup": { "encryption": { "passphraseFile": "~/.talon/backup.key" } }
```

Then **copy the passphrase somewhere off this machine** (a password
manager). **If you lose the key, you lose every encrypted backup, local
and remote.** There is no recovery and no back door. Talon never includes
the key in a snapshot, because a key stored inside the backup it unlocks
protects nothing.

## What is enforced

| Rule                                                           | Default                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote targets (Google Drive, …) receive only encrypted parts  | Always. A snapshot taken without `backup.encryption` stays local, and each target records `failed: remote backup targets require backup.encryption`. |
| Parts are encrypted at rest when a passphrase is configured    | Yes. AES-256-GCM in 1 MiB authenticated records, with a scrypt-derived key (N=2^17, r=8, p=1) and a fresh salt per part.                             |
| Manifests are signed (HMAC-SHA256, scrypt-derived key)         | Yes, when a passphrase is configured.                                                                                                                |
| WhatsApp auth and the userbot's `.user-session` leave the host | **No**, unless `backup.loginSessions: "remote"`.                                                                                                     |
| The passphrase file is left out of every part                  | Always, even if it sits in a backed-up folder. A warning is logged.                                                                                  |
| A restore never deletes or overwrites the passphrase file      | Always, even if it sits in a restored folder.                                                                                                        |
| A missing or unreadable key raises an alert                    | At boot, hourly, and on every `/backup` status. One `backup.key` alert per outage, and a recovery notice once it is readable again.                  |
| Local snapshot files are owner-only                            | `backups/<id>/` is 0700; parts and `manifest.json` are 0600.                                                                                         |
| Restored files are owner-only                                  | Files are 0600 (0700 if they were executable), directories 0700.                                                                                     |

## The key

The passphrase comes from the first of these that is set:

1. the `TALON_BACKUP_PASSPHRASE` environment variable;
2. the file named by `backup.encryption.passphraseFile`, whose trimmed
   contents are the passphrase.

An inline passphrase in `config.json` is rejected on purpose, because
`config.json` is itself inside the backup.

- `talon backup keygen [path]` writes 256 random bits (base64url) with
  mode 600. It never prints the key and refuses to overwrite an existing
  file. Replacing a key orphans every snapshot encrypted with it.
- The default location, `~/.talon/backup.key`, is outside every snapshot
  root. If you point `passphraseFile` somewhere that is backed up
  (`workspace/secrets/`, an `extraPaths` entry), the file is still
  skipped, and a restore leaves it in place, but it is better to keep it
  out.
- If `backup.encryption` is set and no passphrase can be found, the
  snapshot **fails**. It never falls back to plaintext. The daemon checks
  the key at boot and every hour, so a key that goes missing raises the
  `backup.key` alert straight away instead of at the next scheduled run.
  `/backup` status shows the problem too. While it lasts, `/update` is
  refused (its pre-update checkpoint cannot be taken) unless forced.
- **Rotating the key:** generate a new file, point the config at it and
  take a snapshot. Older snapshots still need the old key, so keep it for
  as long as you keep those snapshots.

## Signed manifests

Each part authenticates itself, but the manifest decides which parts get
extracted, which digests count as correct, and where `extra/<n>` trees
are restored to. The manifest is stored next to the parts on every
remote. Without a signature, whoever controls the remote could drop a
part, redirect an extra path, or replace an encrypted part with a
plaintext one of their own and update its digest to match.

When a passphrase is configured, every manifest carries an `auth` block:
an HMAC-SHA256 under a scrypt-derived key over a canonical encoding of
every field except `pinned` and the per-target `remote` status, both of
which legitimately change later. On restore:

- A signed manifest must verify under the configured passphrase, or the
  restore stops before anything is touched.
- A signed manifest that lists a plaintext part is refused.
- An **unsigned** manifest is either a legacy snapshot or one whose
  signature was stripped. It is refused when this install has a backup
  passphrase, or when parts are being fetched from a remote target,
  unless you pass `--allow-unauthenticated`:

  ```sh
  talon backup restore <id> --allow-unauthenticated
  ```

  Use that flag only for snapshots you know were taken before encryption
  was turned on. `/backup restore` from chat has no such override, so use
  the CLI for those.

On a host that has never had a passphrase configured, plaintext snapshots
taken there restore exactly as before.

## Login sessions

`whatsapp-auth/` and `.user-session` (the userbot's login, which is the
operator's own Telegram account) go into their own part,
`logins.tar.zst[.enc]`:

| `backup.loginSessions` | Local snapshots | Remote targets      |
| ---------------------- | --------------- | ------------------- |
| `"local"` (default)    | included        | never uploaded      |
| `"remote"`             | included        | uploaded, encrypted |
| `"off"`                | left out        | left out            |

A restore from a remote copy that lacks the logins part goes ahead
without it. After a disaster, you re-link WhatsApp (a QR scan) and log the
userbot in again. A stolen Drive token is not a logged-in session.

## Restoring onto a fresh machine

1. Install Talon and set `TALON_HOME` if you are not using `~/.talon`.
2. Put the passphrase back, either with
   `export TALON_BACKUP_PASSPHRASE=...` or by writing the key file and a
   minimal config that names it:
   `{"backup":{"encryption":{"passphraseFile":"~/.talon/backup.key"}}}`.
   `talon backup restore` reads only the `backup` block, so no frontend
   config is needed before the restore. The real config comes from the
   snapshot.
3. Copy `backups/<id>/` in: at least `manifest.json`, plus whichever
   parts you have. Missing parts can be fetched with `--from <target>`
   once the target plugin is configured. `talon backup list` picks up
   copied-in directories.
4. `talon backup restore <id>`.
