import type { RouteHost } from "./host.js";
import { claimDevice } from "../credentials/claims.js";
import { hasScope } from "../credentials/principal.js";
import type { BridgeRoutes, RouteContext } from "./table.js";
import {
  asAttachmentRefs,
  asPositiveInt,
  asString,
  deviceIdParam,
} from "./params.js";
import { log, logWarn } from "../../../../util/log.js";

/**
 * GET /events. A per-device credential can only name its own device (and
 * is named by it when it omits the claim) — see credentials/claims.ts.
 */
function openEvents(host: RouteHost, ctx: RouteContext): void {
  const { res, url, principal } = ctx;
  const claim = claimDevice(principal, deviceIdParam(url), host.credentials);
  if (!claim.ok || !principal) {
    host.json(res, 403, {
      ok: false,
      error: claim.ok ? "Forbidden" : claim.error,
    });
    return;
  }
  host.openStream(res, claim.deviceId, principal);
}

/**
 * POST /send. Text naming one of the daemon's slash commands is answered
 * by the daemon; the operator-only ones need the same scope as
 * POST /control, so the caller's scope rides along.
 */
async function postSend(host: RouteHost, ctx: RouteContext): Promise<void> {
  const { req, res, principal } = ctx;
  const body = await host.readJson(req);
  const id = asString(body.chatId) ?? "";
  const text = asString(body.text) ?? "";
  // Multi-file clients send `attachments`; the single-image shape older
  // clients send is folded into the same list by the handler.
  const attachments = asAttachmentRefs(body.attachments);
  const imagePath = asString(body.imagePath);
  const attachmentPath = asString(body.attachmentPath);
  const hasAttachment =
    attachments.length > 0 || Boolean(attachmentPath || imagePath);
  // Text may be empty when a file is attached; require one or the other.
  if (!id || (!text.trim() && !hasAttachment)) {
    host.json(res, 400, {
      ok: false,
      error: "chatId and text (or an attachment) required",
    });
    return;
  }
  const operator = principal !== null && hasScope(principal, "operator");
  host.handlers.send(
    id,
    text,
    { attachments, imagePath, attachmentPath },
    { operator },
  );
  host.json(res, 202, { ok: true });
}

export function chatRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "GET /events"
  | "GET /chats"
  | "POST /chats"
  | "POST /chats/rename"
  | "POST /chats/delete"
  | "POST /chats/reset"
  | "POST /chats/interrupt"
  | "POST /chats/pulse"
  | "POST /queue"
  | "GET /history"
  | "GET /search"
  | "POST /send"
  | "GET /commands"
  | "POST /upload"
  | "GET /media"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Chats ──────────────────────────────────────────────────────────

    // A mesh client names itself here so device-addressed events reach
    // it alone (see sendToDevice); UI clients simply omit it.
    "GET /events": (ctx) => openEvents(host, ctx),
    "GET /chats": ({ res }) => json(res, 200, { chats: h.listChats() }),
    "POST /chats": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { chat: h.createChat(asString(body.title)) });
    },
    "POST /chats/rename": async ({ req, res }) => {
      const body = await readJson(req);
      const chat = h.renameChat(
        asString(body.chatId) ?? "",
        asString(body.title) ?? "",
      );
      return chat
        ? json(res, 200, { chat })
        : json(res, 404, { ok: false, error: "No such chat" });
    },
    "POST /chats/delete": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { ok: h.deleteChat(asString(body.chatId) ?? "") });
    },
    "POST /chats/reset": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { ok: h.resetChat(asString(body.chatId) ?? "") });
    },
    "POST /chats/interrupt": async ({ req, res }) => {
      const body = await readJson(req);
      const ok = await h.interruptTurn(asString(body.chatId) ?? "");
      json(res, 200, { ok });
    },
    "POST /chats/pulse": async ({ req, res }) => {
      const body = await readJson(req);
      h.setPulse(asString(body.chatId) ?? "", body.on === true);
      json(res, 200, { ok: true });
    },
    "POST /queue": async ({ req, res }) => {
      const body = await readJson(req);
      h.queueMessage(asString(body.chatId) ?? "", asString(body.text) ?? "");
      json(res, 200, { ok: true });
    },
    "GET /history": ({ res, url }) => {
      const id = url.searchParams.get("chatId") ?? "";
      const before = asPositiveInt(url.searchParams.get("before"));
      const limit = asPositiveInt(url.searchParams.get("limit"));
      json(res, 200, {
        chatId: id,
        messages: h.history(id, { before, limit }),
      });
    },
    "GET /search": ({ res, url }) => {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json(res, 400, { ok: false, error: "q required" });
      const chatId = url.searchParams.get("chatId") ?? undefined;
      json(res, 200, { results: h.search(q, chatId) });
    },
    "POST /send": (ctx) => postSend(host, ctx),
    "GET /commands": ({ res }) =>
      json(res, 200, { commands: h.listCommands() }),
    "POST /upload": async ({ req, res, url }) => {
      const filename = url.searchParams.get("filename") ?? "upload";
      const contentType =
        req.headers["content-type"] ?? "application/octet-stream";
      const startedAt = Date.now();
      try {
        const attachment = await h.upload(filename, contentType, req);
        // Log both outcomes, with the size and duration that tell a rejected
        // upload from a dropped connection — the JSON answer is otherwise
        // only visible in the app.
        log(
          "native",
          `upload ok: ${attachment.name} (${attachment.size} bytes, ${attachment.mimeType}) in ${Date.now() - startedAt}ms`,
        );
        // `imagePath` mirrors the URL for clients written against the
        // single-image upload response.
        json(res, 200, { ok: true, ...attachment, imagePath: attachment.url });
      } catch (err) {
        // The client can only act on this if it knows why: too large (pick a
        // smaller file), empty (nothing was read), or a server-side failure.
        const error = err instanceof Error ? err.message : String(err);
        const status = /limit/i.test(error)
          ? 413
          : /empty/i.test(error)
            ? 400
            : 500;
        logWarn(
          "native",
          `upload failed (${status}) for ${filename} after ${Date.now() - startedAt}ms: ${error}`,
        );
        json(res, status, { ok: false, error });
      }
    },
    "GET /media": ({ res, url }) =>
      host.serveMedia(res, url.searchParams.get("id") ?? ""),
  };
}
