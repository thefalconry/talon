/**
 * Bridge server handlers — the table that binds the transport's routes
 * (server.ts) to the runtime modules. Each entry is a one-line delegation;
 * anything with logic of its own lives in the module named for it.
 */

import { files } from "../../../util/paths.js";
import { setChatPulse } from "../../../storage/chat-settings.js";
import { getPooledBackend } from "../../../core/engine/backend-controller/index.js";
import { createChat, deleteChat, renameChat } from "../chats/chat-lifecycle.js";
import { broadcastChatUpdated, toClientChat } from "../chats/chat-wire.js";
import { control } from "./control.js";
import { handleNativeCommand, listNativeCommands } from "../commands/index.js";
import {
  pluginItems,
  skillItems,
  togglePlugin,
  toggleSkill,
} from "./extensions.js";
import { historyPage, searchHistory } from "../chats/history.js";
import { readLogEntries } from "./logs.js";
import { listMemory, memoryWhy } from "./memory.js";
import {
  describeAttachment,
  MAX_UPLOAD_BYTES,
  resolveUpload,
  saveUploadStream,
} from "../media/media.js";
import {
  effortLevels,
  listBackends,
  listModels,
  setBackend,
  setEffort,
  setModel,
} from "./models.js";
import { setQueued } from "../turn/queue.js";
import { resetChat } from "../chats/reset.js";
import type { NativeRuntime } from "../runtime.js";
import type { BridgeServerHandlers, SendOptions } from "../bridge/server.js";
import type { ClientAttachment } from "../protocol.js";
import { configSnapshot, applyConfigUpdate } from "./settings.js";
import { bridgeStatus, broadcastStatus } from "./status.js";
import { logWarn } from "../../../util/log.js";
import {
  interruptTurn,
  isBusy,
  liveTurnEvents,
  startTurn,
} from "../turn/turn.js";

/**
 * Turn a `/send` body's attachment references into the records this daemon
 * minted at upload time. Both wire shapes land here: the `attachments` list
 * multi-file clients send, and the `imagePath`/`attachmentPath` pair older
 * single-image clients send. References the daemon cannot account for are
 * dropped — a message can only ever point the model at a file the daemon
 * itself wrote to its uploads dir.
 */
function resolveAttachments(
  runtime: NativeRuntime,
  opts: SendOptions | undefined,
): ClientAttachment[] {
  const refs = [...(opts?.attachments ?? [])];
  if (!refs.length && (opts?.imagePath || opts?.attachmentPath)) {
    refs.push({ url: opts.imagePath, path: opts.attachmentPath });
  }
  const resolved: ClientAttachment[] = [];
  const dropped: string[] = [];
  for (const ref of refs) {
    const found = resolveUpload(runtime, ref);
    if (!found) {
      dropped.push(ref.url ?? ref.path ?? "(empty reference)");
      continue;
    }
    // Same file referenced twice (a re-send of a queued message, say) stays
    // one attachment.
    if (!resolved.some((a) => a.path === found.path)) {
      resolved.push(found);
    }
  }
  // A dropped reference is how "I attached a file and the agent never saw it"
  // happens, so it must not be silent. The usual cause is a media id
  // minted by a previous daemon run — `runtime.uploads` is per-run, so a
  // client that staged a file before a restart and sent it after points at
  // nothing.
  if (dropped.length) {
    logWarn(
      "native",
      `dropped ${dropped.length} unknown attachment reference(s) from /send: ${dropped.join(", ")} — re-upload the file (ids do not survive a daemon restart)`,
    );
  }
  return resolved;
}

export function buildBridgeHandlers(
  runtime: NativeRuntime,
): BridgeServerHandlers {
  const { chats, config, mesh } = runtime;
  return {
    status: () => bridgeStatus(runtime),
    listChats: () => chats.list().map((entry) => toClientChat(runtime, entry)),
    createChat: (title) => createChat(runtime, title),
    renameChat: (id, title) => renameChat(runtime, id, title),
    deleteChat: (id) => deleteChat(runtime, id),
    history: (id, opts) => historyPage(runtime, id, opts),
    search: (query, chatId) => searchHistory(runtime, query, chatId),
    // Memory is daemon-wide state in SQLite, not per-runtime — these are
    // straight delegations to the read-only half of the store.
    listMemory,
    memoryWhy,
    send: (id, text, opts, caller) => {
      const entry = chats.get(id) ?? chats.ensure(id);
      // Resolve the client's references into the records this daemon minted
      // at upload time — dropping anything it can't account for.
      const attachments = resolveAttachments(runtime, opts);
      // A slash command the daemon answers itself never reaches the model,
      // and never waits behind a running turn (`/stop` is for exactly
      // that). A message with files attached is always the model's.
      if (
        !attachments.length &&
        handleNativeCommand(runtime, entry, text, {
          operator: caller?.operator === true,
        })
      ) {
        return;
      }
      // A turn is already running for this chat — don't interrupt it. Park the
      // message as the single queued follow-up (synced to every client); it
      // auto-sends when the running turn ends. `isBusy` reads `liveTurns`,
      // which `runTurn` sets synchronously, so even a rapid second /send from
      // any client is caught here rather than starting a concurrent turn.
      if (isBusy(runtime, entry.id)) {
        const existing = runtime.queuedByChat.get(entry.id);
        if (existing) {
          const combinedText = [existing.text.trim(), text.trim()]
            .filter(Boolean)
            .join("\n\n");
          const combinedAttachments = [...existing.attachments, ...attachments];
          setQueued(runtime, entry.id, {
            text: combinedText,
            attachments: combinedAttachments,
          });
        } else {
          setQueued(runtime, entry.id, { text, attachments });
        }
        return;
      }
      startTurn(runtime, entry, text, { attachments });
    },
    queueMessage: (id, text) => {
      // Edit/replace the queued follow-up's text, keeping whatever files were
      // queued with it. Empty text cancels the whole follow-up, attachments
      // included — the client's queue editor offers no other way to drop it.
      const entry = chats.get(id);
      if (!entry) return;
      const attachments = text.trim()
        ? (runtime.queuedByChat.get(entry.id)?.attachments ?? [])
        : [];
      setQueued(runtime, entry.id, { text, attachments });
    },
    upload: async (filename, contentType, body) => {
      const saved = await saveUploadStream(
        runtime,
        filename,
        body,
        MAX_UPLOAD_BYTES,
      );
      return describeAttachment(runtime, {
        path: saved.path,
        name: filename,
        size: saved.size,
        contentType,
      });
    },
    listModels: (chatId) => listModels(runtime, chatId),
    setModel: (id, model) => setModel(runtime, id, model),
    listBackends: (id) => listBackends(runtime, id),
    setBackend: (id, backend) => setBackend(runtime, id, backend),
    setEffort: (id, effort) => setEffort(runtime, id, effort),
    effortLevels: (id) => effortLevels(runtime, id),
    interruptTurn: (id) => interruptTurn(runtime, id),
    resetChat: (id) => resetChat(runtime, id),
    setPulse: (id, on) => {
      const entry = chats.get(id);
      if (!entry) return;
      setChatPulse(id, on);
      broadcastChatUpdated(runtime, entry);
    },
    getConfig: () => configSnapshot(config),
    setConfig: (update) => {
      const snap = applyConfigUpdate(config, update);
      broadcastStatus(runtime);
      return snap;
    },
    listPlugins: () => pluginItems(config),
    setPluginEnabled: (name, enabled) =>
      togglePlugin(config, getPooledBackend(config.backend), name, enabled),
    listSkills: () => skillItems(),
    setSkillEnabled: (name, enabled) =>
      toggleSkill(config, getPooledBackend(config.backend), name, enabled),
    control,
    listCommands: () => listNativeCommands(),
    logs: ({ lines, minLevel, component }) =>
      readLogEntries(files.log, { limit: lines, minLevel, component }),
    liveTurnEvents: () => liveTurnEvents(runtime),
    mediaPath: (id) => runtime.media.get(id) ?? null,
    mediaName: (id) => runtime.uploads.get(id)?.name ?? null,
    // Mesh routes are thin transport shims over the shared core service —
    // storeLocation wakes any pending fresh-fix waiters inside the service.
    registerDevice: (body) => mesh.register(body),
    storeLocation: (body) => mesh.storeLocation(body),
    listDevices: () => mesh.list(),
    completeCommand: (body) => mesh.completeCommand(body),
    acceptFileUpload: (token, body, fromDeviceId) =>
      mesh.acceptFileUpload(token, body, fromDeviceId),
    openFileDownload: (token, fromDeviceId) =>
      mesh.openFileDownload(token, fromDeviceId),
    openCompanionPair: (token, format) => mesh.openCompanionPair(token, format),
    openNodeInstall: (token, os, arch) => mesh.openNodeInstall(token, os, arch),
    openNodeBinary: (token) => mesh.openNodeBinary(token),
  };
}
