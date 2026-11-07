import fsp from "fs/promises";
import { asAppError } from "../../../lib/errors.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.ts";
import { flowPlaylistConfig, type FlowConfig } from "../playlists/flowPlaylistConfig.ts";
import { buildPlaylistTrackIdentity, normalizePlaylistTrack } from "../playlists/playlistTracks.ts";
import { linkTracksToLibrary } from "../playlists/playlistLibrary.ts";
import { playlistManager } from "../playlists/playlistManager.ts";

const trackFromJob = (job: DownloadJob) => ({
  artistName: job.artistName,
  trackName: job.trackName,
  albumName: job.albumName || null,
  artistMbid: job.artistMbid || null,
  albumMbid: job.albumMbid || null,
  releaseMbid: job.releaseMbid || null,
  trackMbid: job.trackMbid || null,
  releaseYear: job.releaseYear || null,
  durationMs: job.durationMs || null,
  trackNumber: job.trackNumber || null,
  discNumber: job.discNumber || null,
  artistAliases: job.artistAliases || [],
  reason: job.reason || null,
});

const isFile = (filePath: string) =>
  fsp.stat(filePath).then(
    (stat) => stat.isFile(),
    (error: unknown) => {
      if (asAppError(error)?.code === "ENOENT") return false;
      throw error;
    },
  );

const discardStaticPlaylist = async (playlistId: string) => {
  await playlistManager.weeklyReset([playlistId]).catch(() => {});
  flowPlaylistConfig.deleteStaticPlaylist(playlistId);
};

export async function saveFlowAsStaticPlaylist(
  flow: FlowConfig,
  {
    name,
    ownerUserId,
    replacesFlow = false,
  }: { name: string; ownerUserId: number | null; replacesFlow?: boolean },
) {
  const saved = new Map<string, { job: DownloadJob }>();
  for (const job of downloadTracker.getByPlaylistType(flow.id)) {
    if (job.status !== "done" || typeof job.finalPath !== "string") continue;
    const identity = buildPlaylistTrackIdentity(job);
    if (saved.has(identity)) continue;
    if (await isFile(job.finalPath)) saved.set(identity, { job });
  }
  if (saved.size === 0) return null;

  const linked = await linkTracksToLibrary(
    [...saved.values()].flatMap(({ job }) => normalizePlaylistTrack(trackFromJob(job)) ?? []),
    { startedByPlaylist: null },
  );
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name,
    sourceName: flow.name,
    sourceFlowId: flow.id,
    recordHistory: flow.recordHistory,
    tracks: linked.tracks,
    ownerUserId,
    replacesFlowId: replacesFlow ? flow.id : null,
  });
  try {
    await playlistManager.ensurePlaylistArtwork(playlist.id);
    playlistManager.requestPlaylistSync([playlist.id]);
    await playlistManager.scheduleScanLibrary(true);
    schedulePlaylistMbidEnrichment(playlist.id, { reason: "flow-static-playlist", priority: 5 });
  } catch (error) {
    await discardStaticPlaylist(playlist.id);
    throw error;
  }
  return { playlist, trackCount: saved.size };
}
