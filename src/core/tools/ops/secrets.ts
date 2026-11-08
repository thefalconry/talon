/**
 * Secret tools — ask the operator for a password without it crossing the
 * chat. The tool mints a single-use link to a paste form on the native
 * bridge; the value lands in ~/.talon/secrets/<name> and the chat gets a
 * receipt. The model sees the link and the name, never the value.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const secretTools: ToolDefinition[] = [
  {
    name: "request_secret",
    description: `Ask the operator for a secret (password, API key, token) without it passing through the chat. Mints a single-use link, valid about 15 minutes, to a paste form served by Talon's native bridge (the agent-tool twin of /secret <name>). The value is written to ~/.talon/secrets/<name> (mode 600) and this chat gets "stored ✓ as <name>" when it lands. You never see the value: read it from the file when a command needs it, e.g. "$(cat ~/.talon/secrets/<name>)", and never echo it.

Use this whenever you need a credential, and point the operator to it if they start pasting one into the chat. Requires the native bridge on an https:// address.`,
    schema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "File name under ~/.talon/secrets: letters, digits, '.', '_' or '-', starting with a letter or digit (e.g. 'gmail-app-password'). An existing secret of that name is replaced.",
        ),
      purpose: z
        .string()
        .max(200)
        .optional()
        .describe(
          "One line shown on the form so the operator knows what it's for (e.g. 'Gmail app password for the email plugin').",
        ),
    },
    execute: (params, bridge) => bridge("request_secret", params),
    tag: "secrets",
  },
];
