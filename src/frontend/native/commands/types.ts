/**
 * What a native slash-command handler receives. Handlers answer through
 * `reply` rather than a return value, so a command that has more to say
 * later (a snapshot finishing, a restart about to happen) says it in
 * order, and one with nothing to add (`/reset` — the reset emits its own
 * notice) simply says nothing.
 */

import type { ModelCommandDeps } from "../../presentation/model-commands.js";
import type { ChatEntry } from "../chats/chats.js";
import type { NativeRuntime } from "../runtime.js";

export type NativeCommandContext = {
  runtime: NativeRuntime;
  entry: ChatEntry;
  /** Everything after the command name, trimmed. */
  arg: string;
  /** The caller holds the bridge's `operator` scope. */
  operator: boolean;
  /** The shared model-command dependencies for this runtime. */
  deps: ModelCommandDeps;
  /** Post a Markdown reply into the chat. */
  reply(text: string): void;
};

export type NativeCommandHandler = (ctx: NativeCommandContext) => Promise<void>;
