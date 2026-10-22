/*
 * Helper modules that extend dbOps use register(dbOps) to avoid
 * circular imports.
 */
import { dbOps } from "./settings.ts";
import { userOps } from "./users.ts";
import { userIdentityOps } from "./userIdentities.ts";
import registerCache from "./cache.ts";
import registerDiscovery from "./discovery.ts";
import registerOverrides from "./overrides.ts";
import registerLidarr from "./lidarr.ts";
import registerHistory from "./history.ts";
import registerInbox from "./inbox.ts";

registerCache(dbOps);
registerDiscovery(dbOps);
registerOverrides(dbOps);
registerLidarr(dbOps);
registerHistory(dbOps);
registerInbox(dbOps);

export { dbOps, userOps, userIdentityOps };
