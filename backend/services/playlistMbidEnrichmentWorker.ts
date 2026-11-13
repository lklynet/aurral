import * as v from "valibot";
import { createJobWorker } from "./jobs/worker.ts";
import { playlistMbidEnrichmentQueue } from "./jobs/queues.ts";
import { enrichStaticPlaylistMbids } from "./playlistMbidEnrichmentService.ts";

export const playlistMbidEnrichmentSchema = v.looseObject({
  kind: v.literal("playlist-mbid-enrichment"),
  playlistId: v.string(),
});

export const { start: startPlaylistMbidEnrichmentWorker } = createJobWorker(
  playlistMbidEnrichmentQueue,
  {
    schema: playlistMbidEnrichmentSchema,
    processJob: (payload) => enrichStaticPlaylistMbids(payload.playlistId),
  },
);
