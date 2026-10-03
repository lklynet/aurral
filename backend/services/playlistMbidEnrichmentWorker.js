import createHonkerWorker from "./honkerWorkerFactory.js";
import { getPlaylistMbidEnrichmentQueue } from "./honkerDb.js";import {
  enrichStaticPlaylistMbids,
  schedulePlaylistMbidEnrichmentForMissingPlaylists,
} from "./playlistMbidEnrichmentService.js";

async function processPlaylistMbidEnrichment(payload = {}) {
  const kind = String(payload?.kind || payload?.type || "").trim();
  switch (kind) {
    case "playlist-mbid-enrichment": {
      return enrichStaticPlaylistMbids(payload.playlistId, {
        reconcileArtistMbids: payload?.reconcileArtistMbids === true,
      });
    }
    case "playlist-mbid-enrichment-sweep": {
      const jobIds = schedulePlaylistMbidEnrichmentForMissingPlaylists({
        reason: payload?.reason || "sweep",
        reconcileArtistMbids: payload?.reconcileArtistMbids === true,
      });
      return {
        success: true,
        enqueued: jobIds.length,
        jobIds,
      };
    }
    default:
      throw new Error(`Unknown playlist MBID enrichment task: ${kind || "unknown"}`);
  }
}

const {  start: startPlaylistMbidEnrichmentWorker,
  stop: stopPlaylistMbidEnrichmentWorker,
  isRunning: isPlaylistMbidEnrichmentWorkerRunning,
} = createHonkerWorker({
  name: "playlist-mbid-enrichment",
  getQueue: getPlaylistMbidEnrichmentQueue,
  processJob: processPlaylistMbidEnrichment,
  idlePollS: 10,
  retryDelayS: 300,
});

export {
  startPlaylistMbidEnrichmentWorker,
  stopPlaylistMbidEnrichmentWorker,
  isPlaylistMbidEnrichmentWorkerRunning,
};
