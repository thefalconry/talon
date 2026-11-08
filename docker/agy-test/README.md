# Antigravity backend Docker harness

Containerised Talon instance configured for the `agy` backend, running
against a dedicated test bot. (To run agy in *production* from the root
image instead, see [`docs/docker.md`](../../docs/docker.md#antigravity-agy-backend).) Designed to coexist with a production
Talon process on the same host without state, port, or Telegram
collisions.

## This harness cannot be authenticated in CI

Read this first — it is the difference between this harness and the
Codex one.

The Antigravity CLI has **no API key**. It authenticates through a
consumer Google OAuth flow that must be completed **interactively, in a
browser, once per machine**, and caches the result at
`~/.gemini/antigravity-cli/antigravity-oauth-token`. Headless runs
reuse that cache; a non-interactive run with no cache exits with an
`authentication required` error rather than hanging.

There is therefore no secret a CI job can be given that makes this
container work. Options, in descending order of usefulness:

1. **Local, authenticated host** (what this harness is for). Sign in
   once with `agy` on the host, then bind-mount `~/.gemini` — which is
   what `docker-compose.yml` does. This is how the backend was
   verified end to end.
2. **A long-lived self-hosted runner** that a human signed in on once.
   The cached refresh token keeps working, but it is a credential on
   disk with no rotation story; treat the runner as trusted.
3. **CI**: run the unit suite (`npx vitest run src/__tests__/agy-*.test.ts`)
   and skip this harness. The suite fakes the CLI at the
   `child_process.spawn` seam and covers the protocol, so backend
   regressions are caught without an account.

The CLI binary itself is also not on npm — there is no
`@google/antigravity` to `npm ci`. The image expects one bind-mounted
from the host at `/usr/local/bin/agy`.

## Usage

```bash
# 0. One-time, ON THE HOST: sign in interactively.
agy            # complete the Google sign-in, then quit

# 1. Provide the test bot token (kept outside the repo)
set -a && source ~/.config/talon-tests/secrets.env && set +a

# 2. Point at the host's agy binary if it isn't /usr/local/bin/agy
export AGY_BINARY_HOST="$(command -v agy)"

# 3. Prepare a workspace and config on the host
mkdir -p ~/.talon-agy-test
cat > ~/.talon-agy-test/talon.json <<'JSON'
{
  "frontend": "telegram",
  "backend": "agy",
  "model": "gemini-3.8-flash-high",
  "workspace": "/home/node/.talon/workspace"
}
JSON

# 4. Inject the test bot token
sed -i "s|\"backend\":|\"botToken\": \"$TALON_TEST_BOT_TOKEN\", \"backend\":|" \
  ~/.talon-agy-test/talon.json

# 5. Build and run
cd docker/agy-test
docker compose up --build -d
docker compose logs -f talon-agy-test
```

After step 5, DM the test bot from any Telegram account. The container
responds through the Antigravity backend.

To tear down:

```bash
cd docker/agy-test
docker compose down
```

The host workspace at `~/.talon-agy-test/` survives `down`/`up`.
Wipe it manually for a clean-room run.

## Coexistence with production

| Resource       | Production            | Antigravity Docker harness |
| -------------- | --------------------- | -------------------------- |
| Workspace      | `~/.talon/`           | `~/.talon-agy-test/`       |
| Telegram bot   | Production bot token  | Test bot token             |
| Gateway port   | 19876                 | 19880 (container-internal) |
| Container name | n/a (systemd service) | `talon-agy-test`           |

**One caveat the Codex harness does not have:** `~/.gemini` is
*shared*, not isolated. agy reads its MCP servers from the single file
`~/.gemini/config/mcp_config.json`, and both the container's Talon and
any host-side Talon on the `agy` backend write into it. They will not
corrupt each other — every write is an atomic read-modify-write and
every Talon key is scoped `__talon__<chat>__<server>` — but each
process prunes `__talon__*` entries it did not write at startup, so
starting one will drop the other's entries and the other's next turn
will re-add them. Do not run both at once against the same `~/.gemini`
unless you are testing exactly that.

## Requirements

- Docker Engine with the `docker compose` plugin.
- Test bot token at `~/.config/talon-tests/secrets.env` (mode `0600`).
- An `agy` binary on the host, and a completed interactive sign-in
  (see above). No API key exists and none is accepted.

## Notes

- The image runs Talon from TypeScript sources via `node --import tsx`,
  so `devDependencies` are included. Not optimised for a minimal
  production image.
- Neither the Talon gateway (port 19880) nor any internal agy process
  is published outside the container. The bot reaches Telegram and
  Google via outbound HTTPS only.
- Talon runs the CLI with `--dangerously-skip-permissions`, which is
  why a container (rather than the host) is the right place to point
  it at anything you do not fully trust.
