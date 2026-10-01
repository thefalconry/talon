/**
 * Shared types for the modular tool system.
 *
 * Tool definitions are pure data + execute logic — no MCP imports,
 * no bridge coupling.  The MCP server consumes these via composeTools().
 */

import type { ZodRawShape } from "zod";

/** Which frontends a tool is available on.  "all" = every frontend. */
export type ToolFrontend =
  "telegram" | "teams" | "terminal" | "discord" | "native" | "whatsapp" | "all";

/** Domain tags for runtime filtering and grouping. */
export type ToolTag =
  | "messaging"
  | "chat"
  | "history"
  | "members"
  | "media"
  | "stickers"
  | "scheduling"
  | "triggers"
  | "agents"
  | "goals"
  | "memory"
  | "scripts"
  | "skills"
  | "web"
  | "admin"
  | "models"
  | "mesh"
  | "moderation"
  | "native"
  | "backup"
  | "secrets";

/** The bridge caller signature — injected into execute(). */
export type BridgeFunction = (
  action: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * A self-contained tool definition.
 *
 * Contains everything needed to register it with an MCP server
 * AND to know which bridge action it maps to.
 */
export interface ToolDefinition {
  /** MCP tool name (e.g. "send", "react", "fetch_url"). */
  readonly name: string;

  /** Human-readable description shown to the model. */
  readonly description: string;

  /** Zod schema shape for the tool's input parameters. */
  readonly schema: ZodRawShape;

  /**
   * Execute the tool.  Receives validated params and a bridge caller.
   * Returns the raw bridge result (wrapped by the MCP layer).
   */
  readonly execute: (
    params: Record<string, unknown>,
    bridge: BridgeFunction,
  ) => Promise<unknown>;

  /** Which frontends this tool appears on. Omit for all frontends. */
  readonly frontends?: readonly ToolFrontend[];

  /** Grouping tag. */
  readonly tag: ToolTag;

  /**
   * This tool explicitly ends the model's turn. Backend handlers observe
   * this flag to abort their stream loop cleanly after the tool's bridge
   * call completes — without it, the model is free to keep producing
   * trailing prose into private scratchpad after declaring "I'm done",
   * which then trips the flow-violation re-prompt path. With this flag,
   * an end_turn call genuinely ends the turn.
   *
   * Backend abort mechanism is backend-specific (Claude SDK uses
   * Query.interrupt(); other backends manage their own loop) — this flag
   * is the shared declarative signal, not the implementation.
   */
  readonly endsTurn?: boolean;

  /**
   * Reply-delivery plumbing: the tool's observable effect IS the
   * message/reaction the user receives, which every frontend already
   * surfaces as first-class output (a chat message, a reaction). Tools
   * flagged here are excluded from activity timelines — the tool
   * events a frontend shows or persists as "what the model did" —
   * because reporting them there double-counts the reply as work.
   * Declared on the definition so consumers never classify by name.
   */
  readonly delivery?: boolean;
}
