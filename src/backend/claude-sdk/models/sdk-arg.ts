/**
 * The model string handed to the Claude SDK.
 *
 * "default" is not a model to Claude Code: it means "no override", and the
 * CLI then falls back to the account's own `settings.json` `model` key. An
 * account whose settings say `"model": "fable"` therefore ran Fable while the
 * picker showed "Opus 5.5" (the label comes from the catalog's description of
 * the default). Pin the catalog's concrete id for the default instead, so the
 * model the user picked is the model that runs.
 */

import { getModel } from "../../../core/models/catalog.js";

const DEFAULT_ID = "default";
const ONE_MILLION_SUFFIX = "[1m]";
const CONCRETE_ID = /^claude-[a-z][a-z-]*-\d/;

export function toSdkModelArg(id: string): string;
export function toSdkModelArg(id: string | undefined): string | undefined;
export function toSdkModelArg(id: string | undefined): string | undefined {
  if (!id) return id;
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  const wantsOneMillion = lower.endsWith(ONE_MILLION_SUFFIX);
  const stem = wantsOneMillion
    ? lower.slice(0, -ONE_MILLION_SUFFIX.length)
    : lower;
  if (stem !== DEFAULT_ID) return id;

  const info = getModel(DEFAULT_ID);
  const concrete = info?.aliases.find((alias) => CONCRETE_ID.test(alias));
  if (!concrete) return id;

  const base = concrete.endsWith(ONE_MILLION_SUFFIX)
    ? concrete.slice(0, -ONE_MILLION_SUFFIX.length)
    : concrete;
  const isOneMillion = wantsOneMillion || concrete.endsWith(ONE_MILLION_SUFFIX);
  return isOneMillion ? `${base}${ONE_MILLION_SUFFIX}` : base;
}
