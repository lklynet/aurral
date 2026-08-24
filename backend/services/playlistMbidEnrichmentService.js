import {
  enqueuePlaylistMbidEnrichmentJob,
  withHonkerLock,
} from "./honkerDb.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import { playlistManager } from "./weeklyFlow/weeklyFlowPlaylistManager.js";
import { resolveWeeklyFlowTrackContext } from "./weeklyFlow/weeklyFlowTrackResolver.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import {
  flowPlaylistConfig,
  normalizeSharedTrack,
  tracksShareMembership,
} from "./weeklyFlow/weeklyFlowPlaylistConfig.js";
import { dbOps } from "../db/helpers/index.js";

const PLAYLIST_MBID_ENRICHMENT_DELAY_SECONDS = 20;
const ARTIST_MBID_RECONCILIATION_KEY = "playlistArtistMbidReconciliationVersion";
const ARTIST_MBID_RECONCILIATION_VERSION = 1;

function hasValue(value) {
  return String(value || "").trim() !== "";
}

function isMissingMbid(track) {
  return !hasValue(track?.artistMbid) || !hasValue(track?.albumMbid) || !hasValue(track?.trackMbid);
}

function hasMissingJobMbid(track, jobs) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => tracksShareMembership(job, track))
    .some((job) => isMissingMbid(job));
}

function hasMissingPlaylistMbids(playlist) {
  return (Array.isArray(playlist?.tracks) ? playlist.tracks : []).some(isMissingMbid);
}

function mergeMissingString(target, source, key, { overwrite = false } = {}) {
  if (!hasValue(source?.[key])) return undefined;
  const next = String(source[key]).trim();
  if (!overwrite && hasValue(target?.[key])) return undefined;
  if (overwrite && String(target?.[key] || "").trim() === next) return undefined;
  return next;
}

function mergeMissingMetadata(target, source, { includeJobFields = false } = {}) {
  const patch = {};
  const artistMbid = mergeMissingString(target, source, "artistMbid", { overwrite: true });
  if (artistMbid !== undefined) patch.artistMbid = artistMbid;
  for (const key of ["albumMbid", "trackMbid", "albumName", "releaseYear"]) {
    const value = mergeMissingString(target, source, key);
    if (value !== undefined) patch[key] = value;
  }

  if (
    target?.durationMs == null &&
    source?.durationMs != null &&
    Number.isFinite(Number(source.durationMs))
  ) {
    patch.durationMs = Math.max(0, Math.round(Number(source.durationMs)));
  }

  const targetAliases = Array.isArray(target?.artistAliases)
    ? target.artistAliases.filter(Boolean)
    : [];
  const sourceAliases = Array.isArray(source?.artistAliases)
    ? source.artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (targetAliases.length === 0 && sourceAliases.length > 0) {
    patch.artistAliases = [...new Set(sourceAliases)];
  }

  if (!includeJobFields) return patch;

  for (const key of ["trackNumber", "albumTrackCount"]) {
    if (target?.[key] == null && source?.[key] != null && Number.isFinite(Number(source[key]))) {
      patch[key] = Math.max(1, Math.round(Number(source[key])));
    }
  }

  const targetTitles = Array.isArray(target?.albumTrackTitles)
    ? target.albumTrackTitles.filter(Boolean)
    : [];
  const sourceTitles = Array.isArray(source?.albumTrackTitles)
    ? source.albumTrackTitles.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (targetTitles.length === 0 && sourceTitles.length > 0) {
    patch.albumTrackTitles = [...new Set(sourceTitles)];
  }

  return patch;
}

function hasPatch(patch) {
  return patch && typeof patch === "object" && Object.keys(patch).length > 0;
}

function applyPlaylistTrackPatch(track, source) {
  const patch = mergeMissingMetadata(track, source);
  if (!hasPatch(patch)) return track;
  return (
    normalizeSharedTrack({
      ...track,
      ...patch,
    }) || track
  );
}

function findResolutionForTrack(track, resolutions, usedResolutionIndexes) {
  for (let index = 0; index < resolutions.length; index += 1) {
    if (usedResolutionIndexes.has(index)) continue;
    const resolution = resolutions[index];
    if (
      tracksShareMembership(track, resolution.originalTrack) ||
      tracksShareMembership(track, resolution.resolvedTrack)
    ) {
      usedResolutionIndexes.add(index);
      return resolution;
    }
  }
  return null;
}

function matchingJobsForTrack(track, jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => tracksShareMembership(job, track));
}

async function buildResolution(track, jobs, resolveTrackContext, reconcileArtistMbids = false) {
  const shouldResolve =
    isMissingMbid(track) ||
    (reconcileArtistMbids && hasValue(track?.albumMbid)) ||
    hasMissingJobMbid(track, jobs);
  if (!shouldResolve) {
    return null;
  }

  const originalTrack = normalizeSharedTrack(track);
  if (!originalTrack) return null;

  const resolvedTrack = await Promise.resolve()
    .then(() => resolveTrackContext(originalTrack))
    .catch(() => originalTrack);

  const enrichedTrack = applyPlaylistTrackPatch(originalTrack, resolvedTrack);
  const jobMetadata = {
    ...resolvedTrack,
    ...enrichedTrack,
  };
  const trackPatch = mergeMissingMetadata(originalTrack, enrichedTrack);
  const jobNeedsPatch = matchingJobsForTrack(originalTrack, jobs).some((job) =>
    hasPatch(mergeMissingMetadata(job, jobMetadata, { includeJobFields: true })),
  );

  if (!hasPatch(trackPatch) && !jobNeedsPatch) {
    return null;
  }

  return {
    originalTrack,
    resolvedTrack: enrichedTrack,
    jobMetadata,
  };
}

export function schedulePlaylistMbidEnrichment(
  playlistId,
  {
    reason = "playlist-update",
    delaySeconds = PLAYLIST_MBID_ENRICHMENT_DELAY_SECONDS,
    priority = 0,
    reconcileArtistMbids = false,
  } = {},
) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId) return null;
  return enqueuePlaylistMbidEnrichmentJob(
    {
      kind: "playlist-mbid-enrichment",
      playlistId: safePlaylistId,
      reason,
      reconcileArtistMbids: reconcileArtistMbids === true,
      requestedAt: Date.now(),
    },
    {
      delaySeconds,
      priority,
    },
  );
}

export function schedulePlaylistMbidEnrichmentForMissingPlaylists({
  reason = "sweep",
  reconcileArtistMbids = false,
} = {}) {
  const shouldReconcileArtistMbids =
    reconcileArtistMbids === true &&
    Number(dbOps.getJSONSetting(ARTIST_MBID_RECONCILIATION_KEY) || 0) <
      ARTIST_MBID_RECONCILIATION_VERSION;
  const jobIds = [];
  for (const playlist of flowPlaylistConfig.getSharedPlaylists()) {
    const jobs = downloadTracker.getByPlaylistType(playlist.id);
    const hasMissingConfig = hasMissingPlaylistMbids(playlist);
    const hasMissingJobs = (Array.isArray(playlist?.tracks) ? playlist.tracks : []).some((track) =>
      hasMissingJobMbid(track, jobs),
    );
    const hasAlbumMbids = (Array.isArray(playlist?.tracks) ? playlist.tracks : []).some((track) =>
      hasValue(track?.albumMbid),
    );
    if (!hasMissingConfig && !hasMissingJobs && !(shouldReconcileArtistMbids && hasAlbumMbids)) {
      continue;
    }
    const jobId = schedulePlaylistMbidEnrichment(playlist.id, {
      reason,
      delaySeconds: 0,
      priority: -5,
      reconcileArtistMbids: shouldReconcileArtistMbids,
    });
    if (jobId != null) jobIds.push(jobId);
  }
  if (shouldReconcileArtistMbids) {
    dbOps.setJSONSetting(
      ARTIST_MBID_RECONCILIATION_KEY,
      ARTIST_MBID_RECONCILIATION_VERSION,
    );
  }
  return jobIds;
}

export async function enrichSharedPlaylistMbids(
  playlistId,
  {
    resolveTrackContext = resolveWeeklyFlowTrackContext,
    reconcileArtistMbids = false,
  } = {},
) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId) return { missing: true, changed: false };

  const snapshotPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
  if (!snapshotPlaylist) return { missing: true, changed: false };

  const snapshotJobs = downloadTracker.getByPlaylistType(safePlaylistId);
  const snapshotTracks = Array.isArray(snapshotPlaylist.tracks) ? snapshotPlaylist.tracks : [];
  const tracksExamined = snapshotTracks.length;
  let tracksResolved = 0;

  const resolver =
    typeof resolveTrackContext === "function"
      ? resolveTrackContext
      : resolveWeeklyFlowTrackContext;
  const rawResolutions = await mapWithConcurrency(snapshotTracks, 4, (track) =>
    buildResolution(track, snapshotJobs, resolver, reconcileArtistMbids === true),
  );
  const resolutions = rawResolutions.filter(Boolean);
  for (const resolution of resolutions) {
    if (!isMissingMbid(resolution.resolvedTrack)) {
      tracksResolved += 1;
    }
  }

  if (resolutions.length === 0) {
    return {
      missing: false,
      changed: false,
      playlistId: safePlaylistId,
      tracksExamined,
      tracksResolved,
      playlistTracksUpdated: 0,
      jobsUpdated: 0,
    };
  }

  return withHonkerLock(
    `playlist-mutation:${safePlaylistId}`,
    async () => {
      const currentPlaylist = flowPlaylistConfig.getSharedPlaylist(safePlaylistId);
      if (!currentPlaylist) return { missing: true, changed: false };

      const currentTracks = Array.isArray(currentPlaylist.tracks) ? currentPlaylist.tracks : [];
      const usedResolutionIndexes = new Set();
      let playlistTracksUpdated = 0;
      const nextTracks = currentTracks.map((track) => {
        const resolution = findResolutionForTrack(track, resolutions, usedResolutionIndexes);
        if (!resolution) return track;
        const nextTrack = applyPlaylistTrackPatch(track, resolution.resolvedTrack);
        if (nextTrack !== track) playlistTracksUpdated += 1;
        return nextTrack;
      });

      let updatedPlaylist = currentPlaylist;
      if (playlistTracksUpdated > 0) {
        updatedPlaylist = flowPlaylistConfig.updateSharedPlaylist(safePlaylistId, {
          tracks: nextTracks,
        });
      }

      // updateSharedPlaylist already busts cache, but bust again for the full enrichment context
      import("../../services/unifiedSearchService.js").then(({ clearSearchContextCache }) => clearSearchContextCache()).catch(() => {});

      const jobs = downloadTracker.getByPlaylistType(safePlaylistId);
      let jobsUpdated = 0;
      const updatedJobIds = new Set();
      for (const track of nextTracks) {
        const resolution = resolutions.find(
          (entry) =>
            tracksShareMembership(track, entry.originalTrack) ||
            tracksShareMembership(track, entry.resolvedTrack),
        );
        const source = resolution?.jobMetadata || resolution?.resolvedTrack || track;
        for (const job of matchingJobsForTrack(track, jobs)) {
          if (updatedJobIds.has(job.id)) continue;
          const patch = mergeMissingMetadata(job, source, {
            includeJobFields: true,
          });
          if (!hasPatch(patch)) continue;
          if (downloadTracker.updateMetadata(job.id, patch)) {
            jobsUpdated += 1;
            updatedJobIds.add(job.id);
          }
        }
      }

      if (playlistTracksUpdated > 0 || jobsUpdated > 0) {
        playlistManager.updateConfig(false);
        playlistManager.scheduleScanLibrary();
      }

      return {
        missing: false,
        changed: playlistTracksUpdated > 0 || jobsUpdated > 0,
        playlistId: safePlaylistId,
        playlist: updatedPlaylist,
        tracksExamined,
        tracksResolved,
        playlistTracksUpdated,
        jobsUpdated,
      };
    },
    {
      ttlSeconds: 180,
      waitTimeoutMs: 15 * 60 * 1000,
      retryDelayMs: 250,
    },
  );
}
