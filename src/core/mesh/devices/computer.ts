/**
 * Desktop control for mesh devices that have a screen — the daemon half of
 * the node's `computer` command (apps/node/computer.go).
 *
 * Pure functions only: turning tool input into wire params, and a device's
 * answer into what the model reads. The device owns the coordinate space
 * (screen scaled so its longest edge is at most 1280), and a screenshot is
 * rendered at exactly that size, so a pixel in the image, a position in a
 * snapshot and a click target are the same pair of numbers. Nothing here
 * converts coordinates, and nothing should.
 */

import type { DeviceCommandResult, DeviceInfo } from "../types.js";
import type { MeshToolResult } from "../tool-surface.js";

export const COMPUTER_ACTIONS = [
  "screenshot",
  "snapshot",
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/**
 * How long the daemon waits for a `computer` answer. The device bounds each
 * step at 30s itself; this sits above that so the layer that gives up is the
 * device, which can say why.
 */
export const COMPUTER_COMMAND_TIMEOUT_MS = 75_000;

/** Tool-side name → wire name, for the params that are numbers. */
const NUMBER_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ["x", "x"],
  ["y", "y"],
  ["to_x", "toX"],
  ["to_y", "toY"],
  ["dx", "dx"],
  ["dy", "dy"],
  ["count", "count"],
  ["limit", "limit"],
];

const STRING_PARAMS = ["button", "text", "keys"] as const;

/** Which params an action cannot run without. */
const REQUIRED: Record<ComputerAction, readonly string[]> = {
  screenshot: [],
  snapshot: [],
  click: ["x", "y"],
  move: ["x", "y"],
  drag: ["x", "y", "to_x", "to_y"],
  scroll: [],
  type: ["text"],
  key: ["keys"],
};

function isAction(value: unknown): value is ComputerAction {
  return (
    typeof value === "string" &&
    (COMPUTER_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Validate tool input and build the `computer` command params. Checked here
 * as well as on the device so a malformed call fails in milliseconds with a
 * message about the tool's own parameter names.
 */
export function computerCommandParams(input: Record<string, unknown>):
  | { action: ComputerAction; params: Record<string, unknown> }
  | {
      error: string;
    } {
  const action = input.action;
  if (!isAction(action)) {
    return {
      error: `Unknown computer action ${JSON.stringify(action ?? null)} — use one of: ${COMPUTER_ACTIONS.join(", ")}.`,
    };
  }
  const params: Record<string, unknown> = { action };
  for (const [from, to] of NUMBER_PARAMS) {
    const raw = input[from];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { error: `computer ${action}: ${from} must be a number.` };
    }
    params[to] = value;
  }
  for (const key of STRING_PARAMS) {
    const raw = input[key];
    if (typeof raw === "string" && raw !== "") params[key] = raw;
  }
  if (Array.isArray(input.modifiers)) {
    const modifiers = input.modifiers.filter(
      (m): m is string => typeof m === "string" && m.trim() !== "",
    );
    if (modifiers.length > 0) params.modifiers = modifiers;
  }
  const missing = REQUIRED[action].filter((name) => {
    const wire = NUMBER_PARAMS.find(([from]) => from === name)?.[1] ?? name;
    return params[wire] === undefined;
  });
  if (missing.length > 0) {
    return {
      error: `computer ${action} needs ${missing.join(", ")}.`,
    };
  }
  if (action === "scroll" && !params.dx && !params.dy) {
    return { error: "computer scroll needs a non-zero dy or dx." };
  }
  return { action, params };
}

function pair(value: unknown): string | null {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number")
    ? `${value[0]},${value[1]}`
    : null;
}

function spaceOf(data: Record<string, unknown>): string | null {
  const p = pair(data.space);
  return p ? p.replace(",", "x") : null;
}

/** The warning every result carries when input events would be dropped. */
function trustNote(data: Record<string, unknown>): string {
  return data.trusted === false
    ? "\nWarning: talon-node is not trusted for Accessibility on this Mac, so clicks and keys are ignored until it is granted in System Settings › Privacy & Security › Accessibility."
    : "";
}

function describeElement(el: Record<string, unknown>): string {
  const role = typeof el.role === "string" && el.role ? el.role : "Element";
  const label =
    typeof el.label === "string" && el.label
      ? ` ${JSON.stringify(el.label)}`
      : "";
  const value =
    typeof el.value === "string" && el.value
      ? ` = ${JSON.stringify(el.value)}`
      : "";
  const flags = [
    el.focused === true ? "focused" : "",
    el.disabled === true ? "disabled" : "",
  ].filter(Boolean);
  const size =
    typeof el.w === "number" && typeof el.h === "number"
      ? ` ${el.w}x${el.h}`
      : "";
  return `${role}${label}${value} @${el.x},${el.y}${size}${
    flags.length ? ` (${flags.join(", ")})` : ""
  }`;
}

function formatSnapshot(
  device: DeviceInfo,
  data: Record<string, unknown>,
): string {
  const elements = Array.isArray(data.elements)
    ? (data.elements as Array<Record<string, unknown>>)
    : [];
  const app = typeof data.app === "string" && data.app ? data.app : "?";
  const window =
    typeof data.window === "string" && data.window
      ? ` — window ${JSON.stringify(data.window)}`
      : "";
  const total = typeof data.total === "number" ? data.total : elements.length;
  const cut =
    data.truncated === "limit"
      ? ", cut at the element limit"
      : data.truncated === "time"
        ? ", cut at the time budget"
        : "";
  const lines = [
    `[${device.name}] ${app}${window}`,
    `${elements.length} actionable of ${total} elements${cut}. Each line ends with the point to click, in the ${spaceOf(data) ?? "screenshot"} space; pointer at ${pair(data.cursor) ?? "?"}.`,
  ];
  if (typeof data.note === "string" && data.note) lines.push(data.note);
  for (const el of elements) lines.push(describeElement(el));
  if (Array.isArray(data.apps) && data.apps.length > 0) {
    lines.push(`Open apps: ${data.apps.map(String).join(", ")}`);
  }
  return lines.join("\n") + trustNote(data);
}

/** Turn a device's `computer` answer into a tool result. */
export function formatComputerResult(
  device: DeviceInfo,
  action: ComputerAction,
  result: DeviceCommandResult,
): MeshToolResult {
  if (!result.ok) {
    return {
      ok: false,
      text:
        result.message ?? `${device.name} could not run computer ${action}.`,
    };
  }
  const data = result.data ?? {};
  if (action === "snapshot") {
    return { ok: true, text: formatSnapshot(device, data) };
  }
  if (action === "screenshot") {
    const base64 = typeof data.base64 === "string" ? data.base64 : "";
    const mimeType =
      typeof data.mimeType === "string" ? data.mimeType : "image/jpeg";
    if (!base64) {
      return {
        ok: false,
        text: `${device.name} answered the screenshot without an image.`,
      };
    }
    return {
      ok: true,
      text:
        `[${device.name}] screenshot ${data.width}x${data.height} — a pixel in this image is the x,y to click. Pointer at ${pair(data.cursor) ?? "?"}.` +
        trustNote(data),
      image: { data: base64, mimeType },
    };
  }
  const typed =
    action === "type" && typeof data.typed === "number"
      ? ` (${data.typed} characters)`
      : "";
  return {
    ok: true,
    text:
      `[${device.name}] ${action} done${typed}. Pointer at ${pair(data.cursor) ?? "?"}.` +
      trustNote(data),
  };
}
