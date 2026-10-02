/**
 * `model:backend-select` — the /model backend switch.
 *
 * Rebinding drops this chat's session (it isn't portable across backends)
 * but keeps each backend's remembered model pick, so switching back
 * restores what was selected there before.
 */

import { type StringSelectMenuInteraction, MessageFlags } from "discord.js";
import {
  buildModelPickerView,
  MODEL_NAV_PREFIX,
  MODEL_PAGE_SIZE,
} from "../../model-picker.js";
import { setChatBackend } from "../../../../storage/chat-settings.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
  listAvailableBackends,
  rebindChat,
} from "../../../../core/engine/backend-controller/index.js";
import { resetSession } from "../../../../storage/sessions.js";
import { sharesSessionStore } from "../../../../core/agent-runtime/backend-registry.js";
import { resetPulseCheckpoint } from "../../../../core/background/pulse/pulse.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import { logError } from "../../../../util/log.js";
import { safeSlice } from "../../formatting.js";
import type { ComponentContext } from "./types.js";

export async function handleBackendSelect(
  interaction: StringSelectMenuInteraction,
  { config, gateway, chatId }: ComponentContext,
): Promise<void> {
  const backendId = interaction.values[0] ?? "";
  const available = listAvailableBackends(config);
  if (!available.some((b) => b.id === backendId)) {
    await interaction.reply({
      content: "Backend not available.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Booting a cold backend takes seconds — Kilo and OpenCode spawn a server
  // and sweep MCP registrations — and Discord drops an interaction that
  // isn't acknowledged within three. Ack first, edit the panel after.
  try {
    await interaction.deferUpdate();
  } catch {
    /* already acknowledged */
  }
  const fail = async (text: string): Promise<void> => {
    try {
      await interaction.followUp({
        content: text,
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      /* ignore */
    }
  };

  // Resolve the outgoing backend before rebinding — afterwards the chat
  // already points at the new one and the old instance is unreachable.
  const previousId = getBackendIdForChat(chatId);
  const previous = resolveChatBackend(chatId, gateway?.backend);
  const alreadyThere = previousId === backendId;
  const result = alreadyThere
    ? { ok: true as const }
    : await rebindChat(chatId, backendId, config);
  if (!result.ok) {
    await fail(result.error?.slice(0, 200) ?? "Rebind failed.");
    return;
  }
  setChatBackend(chatId, backendId);

  // The pool accepts a backend whose SDK is installed, but the SDK may only
  // be a client for a CLI that isn't (OpenCode and Kilo spawn `opencode` /
  // `kilo`). That surfaces here, on the first real call. Reading the
  // catalog is the cheapest way to find out, and it is needed for the panel
  // anyway — so treat a throw as "this backend can't serve" and put the
  // chat back where it was rather than stranding it somewhere unusable.
  let next = resolveChatBackend(chatId, gateway?.backend);
  let newModel: string | undefined;
  let pres;
  try {
    newModel =
      (await resolveActiveModelForChat(chatId, next, backendId, config))
        .model ?? undefined;
    if (next?.models?.getSettingsPresentation) {
      pres = await next.models.getSettingsPresentation(newModel ?? "", {
        callbackPrefix: "model:",
        navCallbackPrefix: MODEL_NAV_PREFIX,
        pageSize: MODEL_PAGE_SIZE,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logError("discord", `Backend switch to ${backendId} failed`, err);
    if (!alreadyThere) {
      await rebindChat(chatId, previousId, config).catch(() => undefined);
      setChatBackend(chatId, previousId);
    }
    await fail(
      `⚠️ \`${backendId}\` could not start — staying on \`${previousId}\`.\n` +
        `\`\`\`\n${safeSlice(reason, 300)}\n\`\`\``,
    );
    return;
  }

  // Only now is the switch known to hold. Session state doesn't port across
  // backends, so it goes — but each backend's remembered model pick stays,
  // and chat history is never touched (a switch changes who answers, not
  // what was said).
  // A re-pick of the backend already in use clears nothing: the retry after
  // a timed-out interaction must not cost the session a second time.
  if (!alreadyThere) {
    // …except between logins that share a transcript store (Claude
    // accounts): the session id stays valid there.
    if (!sharesSessionStore(previousId, backendId))
      resetSession(chatId, "backend-switch");
    resetPulseCheckpoint(chatId);
    previous?.sessions?.resetChat?.(chatId);
  }

  next = resolveChatBackend(chatId, gateway?.backend);
  // Warming is fire-and-forget: it can take seconds on OpenCode/Kilo and
  // the interaction still has a panel to redraw.
  if (next && next !== previous) {
    void Promise.resolve(next.sessions?.warmSession?.(chatId)).catch(
      () => undefined,
    );
  }

  try {
    await interaction.editReply(
      pres
        ? {
            ...buildModelPickerView(
              pres,
              newModel ?? "_No model selected_",
              backendId,
            ),
          }
        : {
            content: `**Backend:** \`${backendId}\` · model \`${newModel ?? "none"}\``,
            components: [],
          },
    );
  } catch {
    /* ignore */
  }
}
