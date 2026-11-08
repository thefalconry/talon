/**
 * Shared message-list walkers for the remote-server backends.
 *
 * Both `KiloClient.session.messages` and `OpencodeClient.session.messages`
 * return the same wire format: an array of `{ info: { role, ... }, parts: [...] }`
 * objects. The `info` typing is a generic the caller supplies.
 *
 * The runtime guard (`info.role === "assistant"`) lives here and runs once;
 * the generic just labels what the caller intends to consume, so callers
 * never cast through `unknown` themselves.
 */

/**
 * Shape every message in `session.messages` carries — confirmed by curling
 * both servers directly. `info.role` is the only field consulted at runtime;
 * everything else is forwarded to the caller via the `Info` generic.
 */
export interface BackendAssistantMatch<Info> {
  parts: Array<Record<string, unknown>>;
  info?: Info;
}

/**
 * Walk a message list backwards and return the most recent assistant
 * message + its parts list, or `null` when no assistant message exists.
 *
 * `Info` is the backend's own "assistant info" type — both Kilo and
 * OpenCode have one, named `KiloAssistantInfo` / `OpenCodeAssistantInfo`,
 * with the same shape. The cast happens once here behind the runtime
 * `role === "assistant"` check, so callers consume a properly-typed
 * `Info` without further narrowing.
 */
export function findLastAssistantMessage<Info>(
  messages: Array<Record<string, unknown>>,
): BackendAssistantMatch<Info> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const info = m?.info as { role?: string } | undefined;
    if (info?.role !== "assistant") continue;
    const parts = Array.isArray(m.parts)
      ? (m.parts as Array<Record<string, unknown>>)
      : [];
    // Runtime-confirmed assistant info — the generic just labels what the
    // backend consumes. Single documented cast, not duplicated per backend.
    return { parts, info: info as unknown as Info };
  }
  return null;
}
