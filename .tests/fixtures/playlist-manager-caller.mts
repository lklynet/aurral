import { findActiveHonkerJob } from "../../backend/services/honkerDb.ts";
import type { PlaylistManagerCall } from "../helpers/playlistManagerCallers.ts";
import { playlistManager } from "../../backend/services/playlists/playlistManager.ts";

playlistManager.schedulePlaybackScan([]);
findActiveHonkerJob("playback");
process.on("message", (message: PlaylistManagerCall) => {
  process.send?.({ type: "calling" });
  const jobId =
    message.method === "schedulePlaybackScan"
      ? playlistManager.schedulePlaybackScan(...message.args)
      : playlistManager.requestPlaylistSync(...message.args);
  process.send?.({ type: "scheduled", jobId }, () => process.exit(0));
});
process.send?.({ type: "ready" });
