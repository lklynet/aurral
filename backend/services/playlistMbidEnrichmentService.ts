import { enqueuePlaylistMbidEnrichmentJob } from "./honkerDb.ts";
import {
  downloadTracker,
  type DownloadJob,
  type JobFields,
} from "./downloadJobs/downloadTracker.ts";
import { withPlaylistMutationLock } from "./downloadJobs/mutationGuards.ts";
import { playlistManager } from "./playlists/playlistManager.ts";
import { resolveTrackSearchContext } from "./downloadJobs/trackSearchContext.ts";
import { mapWithConcurrency } from "./discovery/helpers.ts";
import {
  flowPlaylistConfig,
  normalizePlaylistTrack,
  tracksShareMembership,
  type PlaylistTrack,
  type StaticPlaylist,
} from "./playlists/flowPlaylistConfig.ts";
import { dbOps } from "../db/helpers/index.ts";

const PLAYLIST_MBID_ENRICHMENT_DELAY_SECONDS = 20;
const ARTIST_MBID_RECONCILIATION_KEY = "playlistArtistMbidReconciliationVersion";
const ARTIST_MBID_RECONCILIATION_VERSION = 1;

type TrackMetadata = JobFields<
  | "artistMbid"
  | "albumMbid"
  | "trackMbid"
  | "albumName"
  | "releaseYear"
  | "durationMs"
  | "artistAliases"
  | "trackNumber"
  | "discNumber"
  | "albumTrackCount"
  | "albumTrackTitles"
>;
type MetadataStringKey = "artistMbid" | "albumMbid" | "trackMbid" | "albumName" | "releaseYear";
type TrackResolution = NonNullable<Awaited<ReturnType<typeof buildResolution>>>;

function hasValue(value: unknown) {
  return String(value || "").trim() !== "";
}

function isMissingMbid(track: TrackMetadata | null | undefined) {
  return !hasValue(track?.artistMbid) || !hasValue(track?.albumMbid) || !hasValue(track?.trackMbid);
}

function hasMissingJobMbid(track: TrackMetadata, jobs: DownloadJob[]) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => tracksShareMembership(job, track))
    .some((job) => isMissingMbid(job));
}

function hasMissingPlaylistMbids(playlist: StaticPlaylist) {
  return (Array.isArray(playlist?.tracks) ? playlist.tracks : []).some(isMissingMbid);
}

function mergeMissingString(
  target: TrackMetadata,
  source: TrackMetadata,
  key: MetadataStringKey,
  { overwrite = false }: { overwrite?: boolean } = {},
) {
  if (!hasValue(source?.[key])) return undefined;
  const next = String(source[key]).trim();
  if (!overwrite && hasValue(target?.[key])) return undefined;
  if (overwrite && String(target?.[key] || "").trim() === next) return undefined;
  return next;
}

function mergeMissingMetadata(
  target: TrackMetadata,
  source: TrackMetadata,
  { includeJobFields = false }: { includeJobFields?: boolean } = {},
) {
  const patch: TrackMetadata = {};
  const artistMbid = mergeMissingString(target, source, "artistMbid", { overwrite: true });
  if (artistMbid !== undefined) patch.artistMbid = artistMbid;
  for (const key of ["albumMbid", "trackMbid", "albumName", "releaseYear"] as const) {
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

  for (const key of ["trackNumber", "albumTrackCount"] as const) {
    if (target?.[key] == null && source?.[key] != null && Number.isFinite(Number(source[key]))) {
      patch[key] = Math.max(1, Math.round(Number(source[key])));
    }
  }
  const samePosition =
    Number(patch.trackNumber ?? target?.trackNumber) === Number(source?.trackNumber);
  if (target?.discNumber == null && samePosition && Number(source?.discNumber) > 0) {
    patch.discNumber = Math.round(Number(source.discNumber));
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

function hasPatch(patch: TrackMetadata) {
  return patch && typeof patch === "object" && Object.keys(patch).length > 0;
}

function applyPlaylistTrackPatch(track: PlaylistTrack, source: TrackMetadata) {
  const patch = mergeMissingMetadata(track, source);
  if (!hasPatch(patch)) return track;
  return (
    normalizePlaylistTrack({
      ...track,
      ...patch,
    }) || track
  );
}

function findResolutionForTrack(
  track: TrackMetadata,
  resolutions: TrackResolution[],
  usedResolutionIndexes: Set<number>,
) {
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

function matchingJobsForTrack(track: TrackMetadata, jobs: DownloadJob[]) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => tracksShareMembership(job, track));
}

async function buildResolution(
  track: PlaylistTrack,
  jobs: DownloadJob[],
  resolveTrackContext: typeof resolveTrackSearchContext,
  reconcileArtistMbids = false,
  groupState: { unavailable: boolean } | null = null,
) {
  const shouldResolve =
    isMissingMbid(track) ||
    (reconcileArtistMbids && hasValue(track?.albumMbid)) ||
    hasMissingJobMbid(track, jobs);
  if (!shouldResolve) {
    return null;
  }

  const originalTrack = normalizePlaylistTrack(track);
  if (!originalTrack) return null;

  let resolvedTrack;
  try {
    resolvedTrack = await Promise.resolve().then(() => resolveTrackContext(originalTrack));
  } catch {
    if (groupState) groupState.unavailable = true;
    return null;
  }
  if (resolvedTrack.metadataUnreachable === true && groupState) {
    groupState.unavailable = true;
  }

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

function resolutionGroupKey(track: PlaylistTrack, index: number) {
  const albumMbid = String(track?.albumMbid || "")
    .trim()
    .toLowerCase();
  if (albumMbid) return `mbid:${albumMbid}`;
  const albumName = String(track?.albumName || "")
    .trim()
    .toLowerCase();
  if (!albumName) return `track:${index}`;
  const artist = String(track?.artistMbid || track?.artistName || "")
    .trim()
    .toLowerCase();
  return `album:${artist}:${albumName}`;
}

export function schedulePlaylistMbidEnrichment(
  playlistId: string,
  {
    reason = "playlist-update",
    delaySeconds = PLAYLIST_MBID_ENRICHMENT_DELAY_SECONDS,
    priority = 0,
    reconcileArtistMbids = false,
  }: {
    reason?: string;
    delaySeconds?: number;
    priority?: number;
    reconcileArtistMbids?: boolean;
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
    Number(dbOps.getJSONSetting<number>(ARTIST_MBID_RECONCILIATION_KEY) || 0) <
      ARTIST_MBID_RECONCILIATION_VERSION;
  const jobIds = [];
  for (const playlist of flowPlaylistConfig.getStaticPlaylists()) {
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
    dbOps.setJSONSetting(ARTIST_MBID_RECONCILIATION_KEY, ARTIST_MBID_RECONCILIATION_VERSION);
  }
  return jobIds;
}

export async function enrichStaticPlaylistMbids(
  playlistId: string | null | undefined,
  {
    resolveTrackContext = resolveTrackSearchContext,
    reconcileArtistMbids = false,
  }: {
    resolveTrackContext?: typeof resolveTrackSearchContext;
    reconcileArtistMbids?: boolean;
  } = {},
) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId) return { missing: true, changed: false };

  const snapshotPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  if (!snapshotPlaylist) return { missing: true, changed: false };

  const snapshotJobs = downloadTracker.getByPlaylistType(safePlaylistId);
  const snapshotTracks = Array.isArray(snapshotPlaylist.tracks) ? snapshotPlaylist.tracks : [];
  const tracksExamined = snapshotTracks.length;
  let tracksResolved = 0;

  const resolver =
    typeof resolveTrackContext === "function" ? resolveTrackContext : resolveTrackSearchContext;
  const groupedTracks = new Map<string, PlaylistTrack[]>();
  snapshotTracks.forEach((track, index) => {
    const key = resolutionGroupKey(track, index);
    const group = groupedTracks.get(key) || [];
    group.push(track);
    groupedTracks.set(key, group);
  });
  const groupedResolutions = await mapWithConcurrency(
    [...groupedTracks.values()],
    4,
    async (tracks) => {
      const groupState = { unavailable: false };
      const results = [];
      for (const track of tracks) {
        if (groupState.unavailable) break;
        results.push(
          await buildResolution(
            track,
            snapshotJobs,
            resolver,
            reconcileArtistMbids === true,
            groupState,
          ),
        );
      }
      return results;
    },
  );
  const rawResolutions = groupedResolutions.flat();
  const resolutions = rawResolutions.filter((resolution) => resolution !== null);
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

  return withPlaylistMutationLock(safePlaylistId, async () => {
    const currentPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
    if (!currentPlaylist) return { missing: true, changed: false };

    const currentTracks = Array.isArray(currentPlaylist.tracks) ? currentPlaylist.tracks : [];
    const usedResolutionIndexes = new Set<number>();
    let playlistTracksUpdated = 0;
    const nextTracks = currentTracks.map((track) => {
      const resolution = findResolutionForTrack(track, resolutions, usedResolutionIndexes);
      if (!resolution) return track;
      const nextTrack = applyPlaylistTrackPatch(track, resolution.resolvedTrack);
      if (nextTrack !== track) playlistTracksUpdated += 1;
      return nextTrack;
    });

    let updatedPlaylist: StaticPlaylist | null = currentPlaylist;
    if (playlistTracksUpdated > 0) {
      updatedPlaylist = flowPlaylistConfig.updateStaticPlaylist(safePlaylistId, {
        tracks: nextTracks,
      });
    }

    // updateStaticPlaylist already busts cache, but bust again for the full enrichment context
    import("./unifiedSearchService.ts")
      .then(({ clearSearchContextCache }) => clearSearchContextCache())
      .catch(() => {});

    const jobs = downloadTracker.getByPlaylistType(safePlaylistId);
    let jobsUpdated = 0;
    const updatedJobIds = new Set<string>();
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
      playlistManager.updateConfig();
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
  });
}
