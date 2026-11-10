/**
 * Tool scope: who gets the full agent, and who gets the conversation-only
 * ("guest") surface.
 *
 * The operator gets everything: shell, files, mail, mesh devices, cron,
 * memory, agents, cross-chat sends. Anyone else who can reach the bot (a
 * member of an allowed group, a DM the operator let in) gets a
 * conversation-only surface, enforced here in the hub:
 *
 *   - Talon tools: an explicit allowlist (reply, react, edit/delete own
 *     messages, read this chat's history and media, look at stickers).
 *     Nothing that runs code, touches files, schedules, remembers, spawns
 *     agents, reaches devices or acts on another chat.
 *   - Parameters: a guest turn may only target its own chat and may
 *     never attach a local file by path (`send(file_path=…)` would
 *     otherwise read any file the daemon can read and hand it over).
 *   - Plugin servers: only those named in `guestPlugins` (default: web
 *     search and the time/weather/currency extras).
 *
 * The decision is made per TURN, from the SENDER — not per chat. A group
 * holds the operator and other people at once, so "this chat is allowed"
 * says nothing about who is asking. The weaver resolves the scope when a
 * turn starts (`resolveTurnScope`) and brackets the turn with it
 * (`enterTurnScope`); the hub reads it on every session and every call
 * (`isGuestTurn`). A turn that batches messages from several people, or
 * whose sender can't be identified, is a guest turn.
 *
 * Backend built-ins that live outside the hub (the Claude SDK's own
 * Bash/Read/Write, Codex's shell) are the backend's job. A backend that
 * can't drop them declares so, and the weaver refuses guest turns on it
 * (see `guestToolScope` in agent-runtime/backend-registry.ts).
 */

export type GuestDmScopeConfig = {
  /**
   * Guest-scope DMs from non-operators (default true). `false` is a legacy
   * opt-out that keeps the full surface in DMs the operator allowed;
   * groups are always scoped per sender.
   */
  enabled?: boolean;
  /** DM chat ids that keep the full surface (e.g. `wa_dm_<number>`). */
  operatorChats?: readonly string[];
  /** Plugin/hub server names a guest may use. */
  guestPlugins?: readonly string[];
  /**
   * Full surface for everyone in a group the operator is a member of
   * (default false). Membership is attested by the frontend per turn
   * (`TurnScopeInput.operatorInChat`).
   */
  operatorGroups?: boolean;
};

export type ToolScope = "operator" | "guest";

/**
 * Sender key for the local operator — terminal and native (bridge-token
 * authenticated) clients, which only the operator can drive.
 */
export const LOCAL_OPERATOR_SENDER = "local:operator";

const DEFAULT_GUEST_PLUGINS: readonly string[] = [
  "brave-search",
  "extras-tools",
];

/** Talon tools a guest may see and call. Everything else is hidden. */
export const GUEST_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "end_turn",
  "send",
  "react",
  "edit_message",
  "delete_message",
  "stop_poll",
  "get_chat_info",
  "read_chat_history",
  "search_chat_history",
  "get_message_by_id",
  "download_media",
  "list_media",
  "get_sticker_pack",
  "download_sticker",
]);

/**
 * Tools whose output is a live credential (an install command or pairing
 * link embedding a bridge bearer token, or a secret-drop link). Operator-only, and their output is delivered
 * to the operator's private chat, never into a shared one.
 */
export const OPERATOR_PRIVATE_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  "make_node_install_link",
  "make_companion_pair_link",
  // A secret-drop link writes into ~/.talon/secrets for whoever opens it.
  "request_secret",
]);

/** Parameters that name another chat. A guest may only name its own. */
const CHAT_TARGET_PARAMS = ["chat_id", "to_chat_id", "from_chat_id"] as const;

type ScopeState = {
  dmScope: boolean;
  /** Operator identities (sender keys) and operator DM chat ids. */
  operators: Set<string>;
  /** The operator's Telegram DM, where private output is delivered. */
  operatorDm: string | null;
  plugins: Set<string>;
  operatorGroups: boolean;
};

let state: ScopeState = {
  dmScope: true,
  operators: new Set(),
  operatorDm: null,
  plugins: new Set(DEFAULT_GUEST_PLUGINS),
  operatorGroups: false,
};

/**
 * Set at bootstrap (and on config reload). `operatorIds` are sender keys
 * in the frontend's own form: a Telegram user id, `wa_dm_<number>`,
 * `discord:<userId>`, `teams:<userId>`.
 */
export function initGuestDmScope(
  cfg: GuestDmScopeConfig | undefined,
  adminUserId?: number,
  operatorIds: readonly string[] = [],
): void {
  const operators = new Set<string>([
    ...(cfg?.operatorChats ?? []),
    ...operatorIds,
  ]);
  if (adminUserId) operators.add(String(adminUserId));
  state = {
    dmScope: cfg?.enabled !== false,
    operators,
    operatorDm: adminUserId ? String(adminUserId) : null,
    plugins: new Set(cfg?.guestPlugins ?? DEFAULT_GUEST_PLUGINS),
    operatorGroups: cfg?.operatorGroups === true,
  };
}

/** Is any of this sender's keys a configured operator? */
function isOperatorSender(senderKeys: readonly string[] | undefined): boolean {
  if (!senderKeys || senderKeys.length === 0) return false;
  return senderKeys.some(
    (key) => key === LOCAL_OPERATOR_SENDER || state.operators.has(key),
  );
}

/** Whether any operator identity is configured at all. */
function hasConfiguredOperator(): boolean {
  return state.operators.size > 0;
}

export type TurnScopeInput = {
  chatId: string;
  isGroup: boolean;
  source: "message" | "pulse" | "cron" | "trigger" | "agent";
  /** Keys of the ONE person behind this turn; absent when unknown/mixed. */
  senderKeys?: readonly string[];
  /** The frontend checked the operator is a member of this group chat. */
  operatorInChat?: boolean;
};

/**
 * Operator or guest, for one turn.
 *
 *   - Background turns the operator set up (cron, triggers, agent
 *     reports) keep the full surface; guests can't create them.
 *   - Pulse in a group reacts to whoever is talking there: guest.
 *   - With `operatorGroups` on, any turn in a group the operator is a
 *     member of is operator — the operator vouches for its members.
 *   - A message turn is operator only when its sender is an operator.
 *     Two legacy DM exceptions keep single-user installs working: the
 *     explicit `guestDmScope.enabled: false` opt-out, and an install with
 *     no operator configured at all (DM access is gated by the frontend's
 *     own allowlist there).
 */
export function resolveTurnScope(input: TurnScopeInput): ToolScope {
  if (input.isGroup && state.operatorGroups && input.operatorInChat) {
    return "operator";
  }
  if (input.source !== "message") {
    return input.source === "pulse" && input.isGroup ? "guest" : "operator";
  }
  if (isOperatorSender(input.senderKeys)) return "operator";
  if (input.isGroup) return "guest";
  if (!state.dmScope || !hasConfiguredOperator()) return "operator";
  return state.operators.has(input.chatId) ? "operator" : "guest";
}

// ── Active turn scopes ──────────────────────────────────────────────────────

/** chatId → scope of the turn currently running there (turns are per-chat FIFO). */
const activeScopes = new Map<string, { scope: ToolScope }>();

/**
 * Mark `chatId`'s running turn with `scope` until the returned release is
 * called. The release only clears its own mark.
 */
export function enterTurnScope(chatId: string, scope: ToolScope): () => void {
  const mark = { scope };
  activeScopes.set(chatId, mark);
  return () => {
    if (activeScopes.get(chatId) === mark) activeScopes.delete(chatId);
  };
}

/**
 * What a guest turn's prompt opens with. The model shares one session per
 * chat across senders, so without it an operator turn followed by a guest
 * turn looks like the MCP servers dropping out from under it — and the
 * model says so in the chat, blaming restarts or a broken supervisor.
 */
export const GUEST_SCOPE_NOTICE =
  "[Tool scope notice: this message is from someone other than the operator, " +
  "so this turn has the conversation-only tool set (replies, reactions, this " +
  "chat's history, web search). Shell, files, plugins and the rest are withheld " +
  "on purpose and come back on the operator's next message. This is access " +
  "control, not a fault — don't report it as tools dropping or try to work around it.]";

/** The prompt a backend sees for a turn of this scope. */
export function scopePrompt(scope: ToolScope, prompt: string): string {
  return scope === "guest" ? `${GUEST_SCOPE_NOTICE}\n\n${prompt}` : prompt;
}

/** Is the turn running in this chat right now guest-scoped? */
export function isGuestTurn(chatId: string): boolean {
  return activeScopes.get(chatId)?.scope === "guest";
}

export function isGuestToolAllowed(name: string): boolean {
  return GUEST_TOOL_ALLOWLIST.has(name);
}

export function isGuestPluginAllowed(serverName: string): boolean {
  return state.plugins.has(serverName);
}

/**
 * Is this chat a private chat with the operator — where credential-bearing
 * output may be shown? The operator's DMs, plus the local frontends.
 */
export function isOperatorPrivateChat(
  frontend: string,
  chatId: string,
): boolean {
  if (frontend === "native" || frontend === "terminal") return true;
  return state.operators.has(chatId) && !chatId.startsWith("-");
}

/** Where private operator output is delivered, if anywhere. */
export function operatorDmChatId(): string | null {
  return state.operatorDm;
}

/**
 * Why a guest call with these params must be refused, or null if it is
 * fine. Checked on every guest tool call, after the allowlist.
 */
export function guestParamViolation(
  chatId: string,
  params: Record<string, unknown>,
): string | null {
  for (const key of CHAT_TARGET_PARAMS) {
    const v = params[key];
    if (v !== undefined && v !== null && String(v) !== chatId) {
      return `${key} must be this chat`;
    }
  }
  if (params.file_path !== undefined) {
    return "file_path is not available here; use a url or file_id";
  }
  const media = params.media;
  if (Array.isArray(media)) {
    for (const item of media) {
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).file_path !== undefined
      ) {
        return "file_path is not available here; use a url or file_id";
      }
    }
  }
  return null;
}
