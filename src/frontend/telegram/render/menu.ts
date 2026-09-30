/**
 * Settings + model-picker UI: settings text, the `/model` main/browse/backend
 * keyboards, effort rows, the model-option list, and the menu-state builder.
 * All pure rendering.
 *
 * The settings body itself is `frontend/presentation/reports.ts`, rendered
 * with Telegram's dialect; everything below it is inline-keyboard shape,
 * which has no counterpart on Discord (Components, not keyboards).
 */

import { escapeHtml } from "../formatting.js";
import type { ReasoningEffortLevel } from "../../../core/types.js";
import { REASONING_LEVEL_LABELS } from "../../../core/models/reasoning-levels.js";
import {
  getModels,
  resolveModel,
  resolveModelId,
  type ModelInfo,
} from "../../../core/models/catalog.js";
import { renderSettingsText as renderSettingsTextWith } from "../../presentation/reports.js";
import { formatModelLabel } from "../../presentation/format.js";
import { TELEGRAM_REPORTS } from "./html.js";

/** Display name for a known ModelInfo. */
export function formatModelOptionLabel(model: ModelInfo): string {
  return model.displayName;
}

/** Compact display name for a known ModelInfo. */
export function formatCompactModelLabel(model: ModelInfo): string {
  return model.displayName;
}

/** One option per distinct display name, in catalog order. */
export function getTelegramModelOptions(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels()) {
    const key = model.displayName.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    options.push(model);
  }

  return options;
}

export function renderSettingsText(
  model: string,
  effort: string,
  proactive: boolean,
  pulseIntervalMs?: number,
  modelDetails?: Array<string>,
): string {
  return renderSettingsTextWith(
    TELEGRAM_REPORTS,
    model,
    effort,
    proactive,
    pulseIntervalMs,
    modelDetails,
  );
}

export function isSelectedModel(
  currentModel: string,
  modelId: string,
): boolean {
  const current = resolveModel(currentModel);
  const candidate = resolveModel(modelId);
  if (current && candidate) {
    return (
      current.displayName.toLowerCase() === candidate.displayName.toLowerCase()
    );
  }
  return resolveModelId(currentModel) === modelId;
}

export type SettingsButton = { text: string; callback_data: string };

/**
 * Optional pager metadata supplied by the backend for the model
 * picker. When present, callers add a filter row (when `freeCount > 0`)
 * and a Prev / page / Next row (when `totalPages > 1`). Backends with
 * small fixed catalogs may omit this entirely.
 */
export interface SettingsPager {
  page: number;
  totalPages: number;
  filter: "all" | "free";
  freeCount: number;
  totalCount: number;
}

/**
 * Build the pager + filter button rows for a model picker. Shared by
 * `/settings` and the standalone `/model` command. `navPrefix` is the
 * callback-data prefix used for filter and pagination buttons —
 * `/settings` uses `settings:models` (so its handler sees
 * `settings:models:page:N:F`), `/model` uses `model:nav` (so its
 * handler sees `model:nav:page:N:F`). A `noopData` sentinel is the
 * callback for disabled-edge buttons (Telegram requires every inline
 * button to carry callback data).
 */
function renderModelPickerControlRows(
  pager: SettingsPager,
  navPrefix: string,
  noopData: string,
  view: "models" | "groups" = "models",
  activeProvider?: string,
): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];
  // When showing one provider's models, offer an explicit way back to
  // the provider list. Encoded as `…:providers` so the callback
  // handler knows to drop the `provider` option on re-render.
  if (view === "models" && activeProvider) {
    rows.push([
      {
        text: `← Providers`,
        callback_data: `${navPrefix}:providers`,
      },
    ]);
  }
  if (pager.totalPages > 1) {
    const prev = Math.max(1, pager.page - 1);
    const next = Math.min(pager.totalPages, pager.page + 1);
    const providerSuffix = activeProvider ? `:${activeProvider}` : "";
    rows.push([
      {
        text: pager.page > 1 ? "← Prev" : "·",
        callback_data:
          pager.page > 1
            ? `${navPrefix}:page:${prev}:${pager.filter}${providerSuffix}`
            : noopData,
      },
      {
        text: `${pager.page} / ${pager.totalPages}`,
        callback_data: noopData,
      },
      {
        text: pager.page < pager.totalPages ? "Next →" : "·",
        callback_data:
          pager.page < pager.totalPages
            ? `${navPrefix}:page:${next}:${pager.filter}${providerSuffix}`
            : noopData,
      },
    ]);
  }
  return rows;
}

// ── /model main-menu + browse view ──────────────────────────────────────────
//
// /model has two screens:
//
//   1. Main menu (`model:menu` callback path) — shows current model +
//      toggles. Free-only toggle persists into chat-settings, so the
//      preference survives bot restarts. "Browse models" drills into
//      screen 2.
//   2. Browse (`model:nav:*` callback path) — provider chips → models
//      with pagination and a "← Back to menu" return button.
//
// All Telegram inline buttons here use callback data ≤ 64 bytes as
// required by https://core.telegram.org/bots/api#inlinekeyboardbutton.

export interface ModelMenuState {
  /**
   * Resolved model id, or empty string when none is selected (see
   * `noModelSelected`). The empty value is a sentinel — never compare
   * to it as a real model id without checking `noModelSelected` first.
   */
  activeModel: string;
  /** Human-readable active model name (display). When no model is
   *  selected this is the "No model selected" sentinel. */
  activeDisplay: string;
  /**
   * True when the 5-step active-model resolver returned null —
   * catalog-driven backend (e.g. OpenAI Agents on OpenRouter, custom
   * OpenAI-compatible) with no per-chat pick AND no
   * `config.backendDefaults[backendId]` configured. UI renders "No
   * model selected"; send guard refuses to call the backend.
   */
  noModelSelected: boolean;
  /** Active model status line(s) shown above the buttons. */
  statusLines: string[];
  /** Whether this chat has a per-chat model override (vs falling back to config default). */
  hasOverride: boolean;
  /** Whether the backend reports any free-tier models — controls visibility of the Free toggle. */
  showFreeToggle: boolean;
  /** Current persisted free-only setting for this chat. */
  freeOnly: boolean;
  /**
   * Backend currently serving this chat (override → role default).
   * `id` is the registry slug; `label` is the display name.
   */
  activeBackend: { id: string; label: string };
  /** True when this chat has a per-chat backend override. */
  hasBackendOverride: boolean;
  /**
   * Whether the picker should offer a "Change backend" button. False
   * when `enabledBackends` limits the menu to a single backend.
   */
  showBackendButton: boolean;
}

/** Inputs needed to build a `ModelMenuState`. Pure-function shape so tests can stub everything. */
export interface BuildModelMenuStateArgs {
  chatId: string;
  /**
   * Resolved active model id, or `null` when the 5-step active-model
   * resolver returned no usable default. UI renders "No model selected"
   * and skips the backend snapshot fetch.
   */
  activeModel: string | null;
  /** Default model for "override" comparison — typically the active
   *  backend's `getDefaultModel()`. */
  defaultModel: string | null;
  freeOnly: boolean;
  /**
   * Backend hook to fetch a passive snapshot of the catalog. We only
   * read `freeCount`, `totalCount`, and `modelDetails` for the body
   * status line — never render `modelButtons` from this call.
   * Skipped entirely when `activeModel` is `null`.
   */
  fetchSnapshot: () => Promise<{
    freeCount: number;
    totalCount: number;
    modelDetails: string[];
  }>;
  /** Resolve display name for the active model. Falls back to the raw id.
   *  Skipped when `activeModel` is `null`. */
  fetchActiveDisplay: () => Promise<string | undefined>;
  /** Backend currently serving this chat — id and human label. */
  activeBackend: { id: string; label: string };
  /** Whether this chat has a per-chat backend override pinned in the pool. */
  hasBackendOverride: boolean;
  /**
   * Whether more than one backend is offered to the user. Drives the
   * "Change backend" button — hide it when there's nothing to switch to.
   */
  showBackendButton: boolean;
}

export async function buildModelMenuState(
  args: BuildModelMenuStateArgs,
): Promise<ModelMenuState> {
  // Null active-model = step 5 of the resolver chain. Render the
  // "no model selected" UI without bothering the backend (which would
  // typically error or return an empty marker).
  if (args.activeModel === null) {
    let freeCount = 0;
    let modelDetails: string[] = [];
    // Still fetch a passive snapshot to learn whether the free toggle
    // should appear — the catalog exists, the user just hasn't picked
    // a model yet. Safe to call with no active model.
    try {
      const snapshot = await args.fetchSnapshot();
      freeCount = snapshot.freeCount;
      modelDetails = snapshot.modelDetails.slice();
    } catch {
      /* keep defaults */
    }
    return {
      activeModel: "",
      activeDisplay: "No model selected",
      noModelSelected: true,
      statusLines: modelDetails,
      hasOverride: false,
      showFreeToggle: freeCount > 0,
      freeOnly: args.freeOnly,
      activeBackend: args.activeBackend,
      hasBackendOverride: args.hasBackendOverride,
      showBackendButton: args.showBackendButton,
    };
  }

  const [snapshot, display] = await Promise.all([
    args.fetchSnapshot().catch(() => ({
      freeCount: 0,
      totalCount: 0,
      modelDetails: [],
    })),
    args.fetchActiveDisplay().catch(() => undefined),
  ]);

  return {
    activeModel: args.activeModel,
    activeDisplay: display ?? args.activeModel,
    noModelSelected: false,
    statusLines: snapshot.modelDetails.slice(),
    hasOverride:
      args.defaultModel !== null && args.activeModel !== args.defaultModel,
    showFreeToggle: snapshot.freeCount > 0,
    freeOnly: args.freeOnly,
    activeBackend: args.activeBackend,
    hasBackendOverride: args.hasBackendOverride,
    showBackendButton: args.showBackendButton,
  };
}

/** Build the main-menu inline keyboard for `/model`. */
export function renderModelMenuKeyboard(
  state: ModelMenuState,
): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];

  rows.push([{ text: "Browse models", callback_data: "model:browse" }]);

  if (state.showBackendButton) {
    rows.push([
      {
        text: `Backend: ${state.activeBackend.label}`,
        callback_data: "model:backends",
      },
    ]);
  }

  if (state.showFreeToggle) {
    rows.push([
      {
        text: state.freeOnly ? "Free only: ON" : "Free only: OFF",
        callback_data: "model:toggle-free",
      },
    ]);
  }

  if (state.hasOverride) {
    rows.push([{ text: "Reset to default", callback_data: "model:reset" }]);
  }

  return rows;
}

/**
 * Build the backend-submenu keyboard. Reached via the "Backend" button
 * on the main `/model` menu; each row is a candidate backend the chat
 * can switch to (plus a "Use default" row when overridden, and a
 * "Back" row).
 */
export function renderBackendMenuKeyboard(opts: {
  available: Array<{ id: string; label: string }>;
  activeBackendId: string;
  hasBackendOverride: boolean;
}): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];
  for (const b of opts.available) {
    const active = b.id === opts.activeBackendId;
    rows.push([
      {
        text: active ? `✅ ${b.label} (active)` : b.label,
        callback_data: active ? "model:noop" : `model:backend:${b.id}`,
      },
    ]);
  }
  if (opts.hasBackendOverride) {
    rows.push([
      {
        text: "Reset to default backend",
        callback_data: "model:backend-default",
      },
    ]);
  }
  rows.push([{ text: "← Back to /model", callback_data: "model:menu" }]);
  return rows;
}

/** Body text for the backend submenu. */
export function renderBackendMenuText(opts: {
  activeBackend: { id: string; label: string };
  hasBackendOverride: boolean;
  defaultBackendLabel: string;
}): string {
  const lines = [
    `<b>Backend</b>`,
    `Active: <b>${opts.activeBackend.label}</b> (<code>${opts.activeBackend.id}</code>)`,
  ];
  if (opts.hasBackendOverride) {
    lines.push(
      `<i>Per-chat override — default is <b>${opts.defaultBackendLabel}</b>.</i>`,
    );
  } else {
    lines.push(`<i>Using the global default.</i>`);
  }
  lines.push(
    "",
    "Switching the backend resets this chat's session — model choice will fall back to the new backend's default.",
  );
  return lines.join("\n");
}

/** Format the body text of the `/model` main menu. */
export function renderModelMenuText(state: ModelMenuState): string {
  const lines: string[] = [];
  if (state.noModelSelected) {
    lines.push(
      `<b>Model:</b> <i>No model selected</i>`,
      `<i>Use the picker below to choose one — sending a message before picking will be refused.</i>`,
    );
  } else {
    lines.push(`<b>Model:</b> <code>${escapeHtml(state.activeDisplay)}</code>`);
  }
  // Display names and status lines are plain text from backend catalogs —
  // a literal `<name>` in a hint (or a `<` in a model id) is otherwise
  // parsed as an HTML tag and Telegram rejects the whole send with 400.
  for (const l of state.statusLines) lines.push(escapeHtml(l));
  if (state.freeOnly && state.showFreeToggle) {
    lines.push("<i>Filtering to free-tier models when browsing.</i>");
  }
  return lines.join("\n");
}

/**
 * Build the inline keyboard for the /model "browse" screen (provider
 * groups OR a paginated model list). `backToMenuData` is the callback
 * sent when the user wants to return to the main menu.
 */
export function renderModelBrowseKeyboard(
  modelButtons: Array<SettingsButton>,
  pager: SettingsPager,
  view: "models" | "groups",
  activeProvider: string | undefined,
  backToMenuData: string,
): Array<Array<SettingsButton>> {
  const cols = 2;
  const modelRows: Array<Array<SettingsButton>> = [];
  for (let i = 0; i < modelButtons.length; i += cols) {
    modelRows.push(modelButtons.slice(i, i + cols));
  }
  const controlRows = renderModelPickerControlRows(
    pager,
    "model:nav",
    "model:noop",
    view,
    activeProvider,
  );
  return [
    ...modelRows,
    ...controlRows,
    [{ text: "← Back to menu", callback_data: backToMenuData }],
  ];
}

/**
 * The /settings keyboard: one button that opens the /model menu (the single
 * place models are browsed and picked), the effort levels the active model
 * registers, and the pulse toggle. `hasModelMenu` is false when the backend
 * has no model catalog — the /model menu cannot render there, so the button
 * would do nothing.
 */
export function renderSettingsKeyboard(
  model: string | null,
  effort: string,
  proactive: boolean,
  reasoningLevels: readonly ReasoningEffortLevel[] = [],
  hasModelMenu = true,
): Array<Array<SettingsButton>> {
  const effortRows = renderEffortRows(
    effort,
    reasoningLevels,
    "settings:effort:",
  );

  const modelRows: Array<Array<SettingsButton>> = hasModelMenu
    ? [
        [
          {
            text: model ? `Model: ${formatModelLabel(model)}` : "Choose model",
            callback_data: "model:menu",
          },
        ],
      ]
    : [];

  return [
    ...modelRows,
    ...effortRows,
    [
      {
        text: proactive ? "Pulse: ON" : "Pulse: OFF",
        callback_data: `settings:proactive:${proactive ? "off" : "on"}`,
      },
    ],
  ];
}

export function renderEffortRows(
  effort: string,
  reasoningLevels: readonly ReasoningEffortLevel[],
  callbackPrefix: string,
): Array<Array<SettingsButton>> {
  if (reasoningLevels.length === 0) return [];
  const buttons: SettingsButton[] = [
    ...reasoningLevels.map((level) => ({
      text:
        effort === level
          ? `✓ ${REASONING_LEVEL_LABELS[level]}`
          : REASONING_LEVEL_LABELS[level],
      callback_data: `${callbackPrefix}${level}`,
    })),
    {
      text: effort === "adaptive" ? "✓ Auto" : "Auto",
      callback_data: `${callbackPrefix}adaptive`,
    },
  ];
  const rows: Array<Array<SettingsButton>> = [];
  for (let i = 0; i < buttons.length; i += 3) {
    rows.push(buttons.slice(i, i + 3));
  }
  return rows;
}
