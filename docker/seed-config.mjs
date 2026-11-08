// First-boot config for container installs (TrueNAS, Unraid, plain Docker).
//
// An appliance UI can hand a container environment variables but not a
// hand-written ~/.talon/config.json, and without one the daemon starts on
// the Telegram frontend with no bot token and exits — a restart loop on the
// very first boot. So when config.json does not exist yet, this writes one
// from TALON_* variables. It never touches an existing file: once the config
// exists it belongs to the operator (and to `talon setup`, /settings, the
// companion's settings sync), and env vars are ignored from then on.
//
// Plain ESM with no imports beyond node: builtins so it runs unchanged under
// both image runtimes (`bun` and `node`) before any of Talon is loaded.
//
//   TALON_FRONTEND        telegram | discord | native | … (comma list ok).
//                         Default: telegram when TALON_BOT_TOKEN is set,
//                         else native (the companion app bridge).
//   TALON_BOT_TOKEN       Telegram bot token.
//   TALON_ADMIN_USER_ID   Telegram user id: made admin AND the only
//                         allowed DM user, so a fresh bot answers no one else.
//                         Required whenever the Telegram frontend is seeded.
//   TALON_BACKEND         claude | agy | codex | kilo | opencode | openai-agents
//   TALON_MODEL           Default model id.
//   TALON_BRIDGE_PORT     Native bridge port (default 19880).
//   TALON_BRIDGE_URL      URL phones/nodes dial, e.g. https://nas.lan:19880
//                         (native.publicUrl). Inside a container the bridge
//                         only knows its internal IP, so pairing links need
//                         this to point anywhere useful.
//   TALON_BRIDGE_TOKEN    Native bridge bearer token (default: auto-minted
//                         into ~/.talon/keys/bridge-token on first start).

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.TALON_HOME || join(homedir(), ".talon");
const file = join(root, "config.json");

if (existsSync(file)) process.exit(0);

const env = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const botToken = env("TALON_BOT_TOKEN");
const frontends = (env("TALON_FRONTEND") ?? (botToken ? "telegram" : "native"))
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);

const config = {
  frontend: frontends.length === 1 ? frontends[0] : frontends,
  ...(botToken ? { botToken } : {}),
  ...(env("TALON_BACKEND") ? { backend: env("TALON_BACKEND") } : {}),
  model: env("TALON_MODEL") ?? "default",
  maxMessageLength: 4000,
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
};

const admin = env("TALON_ADMIN_USER_ID");
if (frontends.includes("telegram") && !admin) {
  // A Telegram bot without an admin has no owner and no access rule; the
  // daemon refuses to start that way, so fail here with the actual fix.
  console.error(
    "[seed-config] TALON_ADMIN_USER_ID is required with the Telegram frontend (TALON_BOT_TOKEN). " +
      "Set it to your numeric Telegram user id (message @userinfobot to find it).",
  );
  process.exit(1);
}
if (admin) {
  const id = Number(admin);
  if (!Number.isInteger(id)) {
    console.error(`[seed-config] TALON_ADMIN_USER_ID must be a number, got "${admin}"`);
    process.exit(1);
  }
  config.adminUserId = id;
  config.allowedUsers = [id];
}

if (frontends.includes("native")) {
  // Inside a container, loopback is unreachable from the LAN — bind every
  // interface. A non-loopback bind turns TLS on and auto-mints a bearer
  // token, so this never serves the agent API open.
  const port = Number(env("TALON_BRIDGE_PORT") ?? 19880);
  config.native = {
    host: "0.0.0.0",
    port,
    ...(env("TALON_BRIDGE_URL") ? { publicUrl: env("TALON_BRIDGE_URL") } : {}),
    ...(env("TALON_BRIDGE_TOKEN") ? { token: env("TALON_BRIDGE_TOKEN") } : {}),
  };
}

mkdirSync(root, { recursive: true, mode: 0o700 });
// Owner-only from birth, like the daemon's own first-run config: it holds
// the bot token.
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(
  `[seed-config] wrote ${file} (frontend: ${frontends.join(", ")}${config.backend ? `, backend: ${config.backend}` : ""})`,
);
