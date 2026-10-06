import { requireAuth, requireAdmin } from "../../middleware/requirePermission.js";
import { registerGeneral } from "./handlers/general.js";
import { registerLidarr } from "./handlers/lidarr.js";
import { registerPlex } from "./handlers/plex.js";
import { registerDownloadClients } from "./handlers/downloadClients.js";
import { registerTasks } from "./handlers/tasks.js";
import { registerStorageHealth } from "./handlers/storageHealth.js";
import { registerPlayback } from "./handlers/playback.js";
import mountRoutes from "../shared/mountRoutes.js";

export default mountRoutes([
  registerGeneral,
  registerLidarr,
  registerPlex,
  registerDownloadClients,
  registerTasks,
  registerStorageHealth,
  registerPlayback,
], [requireAuth, requireAdmin]);
