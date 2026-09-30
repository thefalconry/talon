/**
 * Web tools — URL fetching.
 *
 * Platform-agnostic, available on all frontends.
 * Web search is handled by the Brave Search MCP server when configured.
 * URL fetching is provided here via the `fetch_url` tool.
 * These can be excluded via composeTools({ excludeTags: ["web"] }).
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const webTools: ToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a URL — web pages return text content, image URLs are downloaded to workspace. Use to read articles, download images, or fetch any URL. Bot walls are retried automatically (browser-TLS impersonation, then any configured exits/browser); the result footer names the route that worked. A 404 means the URL is wrong, not that you were blocked.",
    schema: {
      url: z.string().describe("The URL to fetch"),
    },
    execute: (params, bridge) => bridge("fetch_url", params),
    tag: "web",
  },
];
