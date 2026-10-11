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

/** snapshot scopes: the frontmost window, or that plus the system's own UI. */
export const SNAPSHOT_SCOPES = ["front", "all"] as const;

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
  if (input.scope !== undefined && input.scope !== null && input.scope !== "") {
    if (!(SNAPSHOT_SCOPES as readonly unknown[]).includes(input.scope)) {
      return {
        error: `computer ${action}: scope must be one of ${SNAPSHOT_SCOPES.join(", ")}.`,
      };
    }
    params.scope = input.scope;
  }
  if (typeof input.verify === "boolean") params.verify = input.verify;
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

function describeElement(
  el: Record<string, unknown>,
  omitWhere = false,
): string {
  const role = typeof el.role === "string" && el.role ? el.role : "Element";
  const label =
    typeof el.label === "string" && el.label
      ? ` ${JSON.stringify(el.label)}`
      : "";
  // A toggle's raw value ("0"/"1") says less than its state, shown below.
  const value =
    typeof el.value === "string" &&
    el.value &&
    !(typeof el.state === "string" && el.state)
      ? ` = ${JSON.stringify(el.value)}`
      : "";
  const flags = [
    typeof el.state === "string" && el.state ? el.state : "",
    el.selected === true ? "selected" : "",
    el.expanded === true ? "expanded" : "",
    el.focused === true ? "focused" : "",
    el.disabled === true ? "disabled" : "",
  ].filter(Boolean);
  const size =
    typeof el.w === "number" && typeof el.h === "number"
      ? ` ${el.w}x${el.h}`
      : "";
  const where = [
    typeof el.app === "string" && el.app ? el.app : "",
    typeof el.window === "string" && el.window && el.window !== el.app
      ? JSON.stringify(el.window)
      : "",
  ].filter(Boolean);
  return `${role}${label}${value} @${el.x},${el.y}${size}${
    flags.length ? ` (${flags.join(", ")})` : ""
  }${where.length && !omitWhere ? ` [${where.join(" ")}]` : ""}`;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
    : [];
}

/** The `scope: "all"` part of a snapshot: menu bar, extras, other windows. */
function formatSystem(system: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const menuBar = records(system.menuBar);
  if (menuBar.length > 0) {
    lines.push(
      `Menu bar: ${menuBar.map((m) => `${String(m.label)} @${m.x},${m.y}`).join(" · ")}`,
    );
  }
  const extras = records(system.extras);
  if (extras.length > 0) {
    lines.push("Menu bar extras (click one to open its menu or panel):");
    for (const x of extras) {
      const value =
        typeof x.value === "string" && x.value
          ? ` = ${JSON.stringify(x.value)}`
          : "";
      const owner =
        typeof x.app === "string" && x.app && x.app !== x.label
          ? ` [${x.app}]`
          : "";
      lines.push(
        `  ${JSON.stringify(String(x.label))}${value} @${x.x},${x.y}${owner}`,
      );
    }
  }
  const windows = records(system.windows);
  if (windows.length > 0) {
    lines.push("Other on-screen windows, frontmost first:");
    for (const w of windows) {
      const title =
        typeof w.title === "string" && w.title
          ? ` ${JSON.stringify(w.title)}`
          : "";
      const walked =
        typeof w.walked === "number" ? `, ${w.walked} controls below` : "";
      lines.push(
        `  ${String(w.app)}${title} at ${w.x},${w.y} ${w.w}x${w.h}${walked}`,
      );
    }
  }
  const elements = records(system.elements);
  if (elements.length > 0) {
    const cut =
      system.truncated === "limit"
        ? " (cut at the element limit)"
        : system.truncated === "time"
          ? " (cut at the time budget)"
          : "";
    lines.push(
      `System UI controls — menus, popovers, Control Center, panels${cut}:`,
    );
    for (const el of elements) lines.push(`  ${describeElement(el)}`);
  }
  return lines;
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
  if (typeof data.system === "object" && data.system !== null) {
    lines.push(...formatSystem(data.system as Record<string, unknown>));
  }
  if (Array.isArray(data.apps) && data.apps.length > 0) {
    lines.push(`Open apps: ${data.apps.map(String).join(", ")}`);
  }
  return lines.join("\n") + trustNote(data);
}

/**
 * What a click hit and what it did: the control under the point before the
 * click, the same control read again afterwards (a toggle shows its new
 * state), and whatever is under the point now (a menu or popover that
 * opened). Empty for nodes that predate it.
 */
function formatClickCheck(data: Record<string, unknown>): string {
  const target = records([data.target])[0];
  if (!target) return "";
  const lines = [`\nHit: ${describeElement(target)}`];
  const after = records([data.targetAfter])[0];
  if (after) {
    const was = typeof target.state === "string" ? target.state : "";
    const now = typeof after.state === "string" ? after.state : "";
    lines.push(
      was && now && was !== now
        ? `Now: ${describeElement(after, true)} — switched ${was} → ${now}`
        : `Now: ${describeElement(after, true)}${was && was === now ? " — state unchanged" : ""}`,
    );
  } else if (data.targetGone === true) {
    lines.push("Now: that control is gone (its menu or panel closed).");
  }
  const under = records([data.under])[0];
  if (under && describeElement(under) !== describeElement(after ?? target)) {
    lines.push(`Under the pointer now: ${describeElement(under)}`);
  }
  return lines.join("\n");
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
    const scale = typeof data.scale === "number" ? data.scale : 1;
    const mapping =
      scale > 1.001
        ? ` — shrunk to fit the transport from the ${spaceOf(data) ?? "click"} space: multiply an image pixel by ${scale} to get the x,y to click`
        : " — a pixel in this image is the x,y to click";
    return {
      ok: true,
      text:
        `[${device.name}] screenshot ${data.width}x${data.height}${mapping}. Pointer at ${pair(data.cursor) ?? "?"}.` +
        trustNote(data),
      image: { data: base64, mimeType },
    };
  }
  if (action === "click") {
    return {
      ok: true,
      text:
        `[${device.name}] click done. Pointer at ${pair(data.cursor) ?? "?"}.` +
        formatClickCheck(data) +
        trustNote(data),
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
