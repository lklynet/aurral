import { findActiveHonkerJob } from "../../backend/services/honkerDb.js";
import { playlistManager } from "../../backend/services/playlists/playlistManager.js";

playlistManager.schedulePlaybackScan([]);
findActiveHonkerJob("system-task");
process.on("message", ({ paths }) => {
  process.send({ type: "calling" });
  const jobId = playlistManager.schedulePlaybackScan(paths);
  process.send({ type: "scheduled", jobId }, () => process.exit(0));
});
process.send({ type: "ready" });
