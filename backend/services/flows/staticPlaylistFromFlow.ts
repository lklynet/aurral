import fsp from "fs/promises";
import * as v from "valibot";
import { asAppError } from "../../../lib/errors.ts";
import { RETIRED_FLOWS_SETTING } from "../../config/db-sqlite.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import { remapLegacyPath } from "../downloadPaths.ts";
import { schedulePlaylistMbidEnrichment } from "../playlistMbidEnrichmentService.ts";
import {
  buildPlaylistTrackIdentity,
  flowPlaylistConfig,
  type FlowConfig,
} from "../playlists/flowPlaylistConfig.ts";
import { playlistManager } from "../playlists/playlistManager.ts";
import { processPlaylistOperation } from "../playlists/playlistOperations.ts";

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
  const saved = new Map<string, { job: DownloadJob; filePath: string }>();
  for (const job of downloadTracker.getByPlaylistType(flow.id)) {
    if (job.status !== "done" || typeof job.finalPath !== "string") continue;
    const identity = buildPlaylistTrackIdentity(job);
    if (saved.has(identity)) continue;
    const filePath = remapLegacyPath(job.finalPath, downloadWorker.downloadRoot);
    if (await isFile(filePath)) saved.set(identity, { job, filePath });
  }
  if (saved.size === 0) return null;

  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name,
    sourceName: flow.name,
    sourceFlowId: flow.id,
    recordHistory: flow.recordHistory,
    tracks: [...saved.values()].map(({ job }) => trackFromJob(job)),
    ownerUserId,
    replacesFlowId: replacesFlow ? flow.id : null,
  });
  try {
    for (const { job, filePath } of saved.values()) {
      const jobId = downloadTracker.addJob(trackFromJob(job), playlist.id);
      if (jobId) downloadTracker.setDone(jobId, filePath, job.albumName || null);
    }
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

export async function convertRetiredFlows() {
  for (const flowId of dbOps.getJSONSetting(RETIRED_FLOWS_SETTING, v.array(v.string())) ?? []) {
    const flow = flowPlaylistConfig.getFlow(flowId);
    if (!flow) continue;
    try {
      if (downloadTracker.getByPlaylistId(flowId).some((job) => job.status === "done")) {
        const leftover = flowPlaylistConfig
          .getStaticPlaylists()
          .find((playlist) => playlist.sourceFlowId === flowId && playlist.name === flow.name);
        if (leftover) await discardStaticPlaylist(leftover.id);
        const saved = await saveFlowAsStaticPlaylist(flow, {
          name: flow.name,
          ownerUserId: flow.ownerUserId,
          replacesFlow: true,
        });
        if (!saved) throw new Error("none of its track files were found");
      }
      await processPlaylistOperation({ kind: "delete-flow", flowId });
    } catch (error) {
      console.warn(
        `[Flows] Could not turn retired flow "${flow.name}" into a playlist:`,
        asAppError(error)?.message,
      );
    }
  }
  dbOps.setJSONSetting(RETIRED_FLOWS_SETTING, []);
}
