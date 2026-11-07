import * as v from "valibot";
import { createJobWorker } from "./jobs/worker.ts";
import { playlistMbidEnrichmentQueue } from "./jobs/queues.ts";
import {
  enrichStaticPlaylistMbids,
  schedulePlaylistMbidEnrichmentForMissingPlaylists,
} from "./playlistMbidEnrichmentService.ts";

const reconcileArtistMbids = v.optional(v.boolean());

export const playlistMbidEnrichmentSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("playlist-mbid-enrichment"),
    playlistId: v.string(),
    reconcileArtistMbids,
  }),
  v.looseObject({
    kind: v.literal("playlist-mbid-enrichment-sweep"),
    reason: v.optional(v.string()),
    reconcileArtistMbids,
  }),
]);

async function processPlaylistMbidEnrichment(
  payload: v.InferOutput<typeof playlistMbidEnrichmentSchema>,
) {
  if (payload.kind === "playlist-mbid-enrichment") {
    return enrichStaticPlaylistMbids(payload.playlistId, {
      reconcileArtistMbids: payload.reconcileArtistMbids === true,
    });
  }
  const jobIds = schedulePlaylistMbidEnrichmentForMissingPlaylists({
    reason: payload.reason || "sweep",
    reconcileArtistMbids: payload.reconcileArtistMbids === true,
  });
  return { success: true, enqueued: jobIds.length, jobIds };
}

const {
  start: startPlaylistMbidEnrichmentWorker,
  stop: stopPlaylistMbidEnrichmentWorker,
  isRunning: isPlaylistMbidEnrichmentWorkerRunning,
} = createJobWorker(playlistMbidEnrichmentQueue, {
  schema: playlistMbidEnrichmentSchema,
  processJob: processPlaylistMbidEnrichment,
});

export {
  startPlaylistMbidEnrichmentWorker,
  stopPlaylistMbidEnrichmentWorker,
  isPlaylistMbidEnrichmentWorkerRunning,
};
