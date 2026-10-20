import { findActiveHonkerJob } from "../../backend/services/honkerDb.js";
import { playlistManager } from "../../backend/services/playlists/playlistManager.js";

playlistManager.schedulePlaybackScan([]);
findActiveHonkerJob("playback");
process.on("message", ({ method, args }) => {
  process.send({ type: "calling" });
  const jobId = playlistManager[method](...args);
  process.send({ type: "scheduled", jobId }, () => process.exit(0));
});
process.send({ type: "ready" });
