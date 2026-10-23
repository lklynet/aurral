import { requireAuth, requireAdmin } from "../../middleware/requirePermission.ts";
import { registerGeneral } from "./handlers/general.ts";
import { registerLidarr } from "./handlers/lidarr.ts";
import { registerPlex } from "./handlers/plex.ts";
import { registerDownloadClients } from "./handlers/downloadClients.ts";
import { registerTasks } from "./handlers/tasks.ts";
import { registerStorageHealth } from "./handlers/storageHealth.ts";
import { registerPlayback } from "./handlers/playback.ts";
import mountRoutes from "../shared/mountRoutes.ts";

export default mountRoutes(
  [
    registerGeneral,
    registerLidarr,
    registerPlex,
    registerDownloadClients,
    registerTasks,
    registerStorageHealth,
    registerPlayback,
  ],
  [requireAuth, requireAdmin],
);
