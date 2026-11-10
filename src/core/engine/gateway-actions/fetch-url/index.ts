/**
 * `fetch_url` — fetch a URL, returning extracted text for HTML/JSON or saving
 * binary content (validated by magic bytes) into the uploads workspace.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  advertisedBinaryKind,
  decodeText,
  detectBinaryType,
  extractText,
  isHtmlContent,
  isTextContent,
  matchesBinaryKind,
} from "../../../tools/content/web-content.js";
import { dirs } from "../../../../util/paths.js";
import { getPoolConfig } from "../../backend-controller/index.js";
import type { SharedActionHandlers } from "../types.js";
import { logDebug } from "../../../../util/log.js";
import { buildFetchLadder } from "../../../fetch/index.js";
import { BlockedUrlError } from "./guard.js";

const MAX_RESPONSE_MB = 50;
const MAX_RESPONSE_BYTES = MAX_RESPONSE_MB * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;

/** Cap returned text, marking the cut so truncation is never silent. */
function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Content truncated at ${MAX_TEXT_CHARS} characters]`;
}

/** Reject anything that isn't a well-formed http(s) URL. */
function urlError(url: string): string | undefined {
  if (!url) return "Missing URL";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "URL must use http or https protocol";
    }
  } catch {
    return "Invalid URL";
  }
  return undefined;
}

/** Turn a text-ish body into the tool's text result. */
function textResult(
  mimeType: string,
  buffer: Buffer,
  ct: string,
): { ok: true; text: string } {
  const trimmed = decodeText(buffer, ct).trim();
  if (!trimmed) return { ok: true, text: "(Page has no readable content)" };

  // extractText is a DOM extractor — running it on JSON/XML/JavaScript/
  // plain text strips small payloads like {"status":"ok"} to nothing,
  // so only HTML (declared or sniffed) goes through it.
  if (!isHtmlContent(mimeType, trimmed)) {
    return { ok: true, text: capText(trimmed) };
  }
  const text = extractText(trimmed, Number.POSITIVE_INFINITY);
  if (text.length < 20)
    return { ok: true, text: "(Page has no readable content)" };
  return { ok: true, text: capText(text) };
}

/** Footer naming the rung that got the page, plus any caveat. */
function footer(via: string, note?: string): string {
  return `\n\n[fetched via ${via}${note ? ` — ${note}` : ""}]`;
}

export const fetchUrlHandlers: SharedActionHandlers = {
  fetch_url: async (body) => {
    const url = String(body.url ?? "");
    const invalid = urlError(url);
    if (invalid) return { ok: false, error: invalid };
    try {
      // The ladder (core/fetch) climbs browser-TLS impersonation → SOCKS
      // exits → plain fetch → browser → egress device until one answers
      // with content, and stops early on a definitive answer (a 404).
      // Local addresses are reachable by default; with
      // `fetchUrl.allowPrivateNetworks: false` every hop is checked against
      // private/loopback/link-local ranges (see guard.ts).
      const ladder = buildFetchLadder(getPoolConfig(), {
        maxBytes: MAX_RESPONSE_BYTES,
      });
      const result = await ladder.fetch(url);
      if (!result.ok) return { ok: false, error: result.error };
      logDebug("fetch", `fetch via ${result.via} (${new URL(url).host})`);
      const via = footer(result.via, result.note);
      const ct = result.headers.get("content-type") ?? "";
      const buffer = result.body;

      const mimeType = ct.split(";")[0].trim().toLowerCase();
      if (isTextContent(mimeType, buffer)) {
        const text = textResult(mimeType, buffer, ct);
        return { ...text, text: text.text + via };
      }

      if (buffer.length === 0)
        return { ok: false, error: "Empty response (0 bytes)" };

      const detected = await detectBinaryType(buffer);
      const advertised = advertisedBinaryKind(mimeType);

      // Do not save an error page or arbitrary bytes under a trusted-looking
      // image/PDF/ZIP extension merely because the server advertised one.
      if (advertised && !matchesBinaryKind(advertised, detected, buffer)) {
        const text = extractText(decodeText(buffer, ct), 500);
        return {
          ok: false,
          error: `Server returned invalid ${advertised} content.${text ? ` Content: ${text}` : ""}`,
        };
      }

      const uploadsDir = dirs.uploads;
      if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
      const filePath = resolve(
        uploadsDir,
        `${Date.now()}-${randomUUID().slice(0, 8)}-fetched.${detected?.ext ?? "bin"}`,
      );
      writeFileSync(filePath, buffer);
      const typeLabel = detected?.mime.startsWith("image/")
        ? "image"
        : (detected?.ext ?? ct.split("/")[1]?.split(";")[0] ?? "file");
      return {
        ok: true,
        text: `Downloaded ${typeLabel} (${(buffer.length / 1024).toFixed(0)}KB) to: ${filePath}\nRead it with the Read tool or send it with send(type="file", file_path="${filePath}").${via}`,
      };
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        return { ok: false, error: err.message };
      }
      return {
        ok: false,
        error: `Fetch failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  },
};
