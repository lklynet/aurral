/*
 * Helper modules that extend dbOps use register(dbOps) to avoid
 * circular imports.
 */
import { dbOps } from "./settings.js";
import { getInternalUserEmail, userOps } from "./users.js";
import registerCache from "./cache.js";
import registerDiscovery from "./discovery.js";
import registerOverrides from "./overrides.js";
import registerLidarr from "./lidarr.js";
import registerHistory from "./history.js";
import registerInbox from "./inbox.js";

registerCache(dbOps);
registerDiscovery(dbOps);
registerOverrides(dbOps);
registerLidarr(dbOps);
registerHistory(dbOps);
registerInbox(dbOps);

export { dbOps, getInternalUserEmail, userOps };
