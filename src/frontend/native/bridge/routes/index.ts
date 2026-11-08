/**
 * One handler per BRIDGE_ROUTE_AUTH key, assembled from the route groups.
 * The return type makes the object exhaustive: a route declared in the
 * table without a handler here, or vice versa, does not compile.
 */
import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { preAuthRoutes } from "./pre-auth.js";
import { chatRoutes } from "./chats.js";
import { memoryRoutes } from "./memory.js";
import { modelRoutes } from "./models.js";
import { daemonRoutes } from "./daemon.js";
import { meshRoutes } from "./mesh.js";
import { authRoutes } from "./auth.js";

export function buildRoutes(host: RouteHost): BridgeRoutes {
  return {
    ...preAuthRoutes(host),
    ...chatRoutes(host),
    ...memoryRoutes(host),
    ...modelRoutes(host),
    ...daemonRoutes(host),
    ...meshRoutes(host),
    ...authRoutes(host),
  };
}
