import path from "node:path";
import { expandAlbumGrabHistory, queuedAlbumGrabs } from "./albumGrabActivity.ts";
import { dbOps } from "../db/helpers/index.ts";
import { resolveBlockedJobReleaseTitle, resolveBlockedJobSourceFilename } from "./downloadUtils.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { getLibraryAlbumIdsByReference } from "./libraryQueryService.ts";
import type { AurralHistoryEntry, TrackUpgrade } from "../db/helpers/history.ts";
import type { AnyQueue, JsonObject } from "./jobs/queue.ts";
import {
  discoveryRefreshQueue,
  downloadPipelineQueue,
  flowRunQueue,
  playlistOperationQueue,
} from "./jobs/queues.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import type { LidarrClient } from "./lidarrClient.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import {
  parseLidarrSearchContext,
  resolveAlbumSearchOutcome,
  albumHasTrackFiles,
  getLidarrAlbumsById,
} from "./albumSearchState.ts";
import {
  MAX_AGE_MS,
  albumRequestReferenceId,
  buildPlaylistHref,
  buildTrackJobHref,
  downloadClientSuffix,
  recordAlbumSearchCompleted,
  recordAlbumSearchFailed,
  recordDiscoveryRefreshFailed,
  recordTrackJobBlocked,
  recordTrackJobCancelled,
  recordTrackJobCompleted,
  recordTrackJobFailed,
  reportRecordFailure,
  requesterFromMetadata,
  resolvePlaylistName,
  resolveTrackDownloadHistorySource,
  stableId,
  upsertAurralHistory,
  type HistoryJob,
  type RequesterUser,
} from "./aurralHistoryService.ts";

const STALE_TRACK_JOB_MS = 15 * 60 * 1000;

const STALE_AURRAL_JOB_MS = 60 * 60 * 1000;

const KIND_SOURCE_MAP = {
  album_requested: "lidarr",
  artist_added: "lidarr",
  track_reused_lidarr: "lidarr",
  track_reused_aurral: "aurral",
  discovery_refresh: "aurral",
  flow_generating: "aurral",
  playlist_tracks_added: "aurral",
};

const ACTIVITY_HIDDEN_KINDS = new Set([
  "album_grab",
  "discovery_refresh",
  "flow_generating",
  "playlist_tracks_added",
  "track_reused_aurral",
]);

const toIso = (createdAt: number) => {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) {
    return new Date().toISOString();
  }
  return new Date(value).toISOString();
};

const resolveHistorySource = (
  kind: string | null,
  metadata: Record<string, unknown> | null = null,
) => {
  if (kind === "track_download") {
    return resolveTrackDownloadHistorySource(metadata?.downloadSource, metadata?.downloadClient);
  }
  if (metadata?.managedBy === "aurral") return "aurral";
  return kind !== null && isOwnKey(KIND_SOURCE_MAP, kind) ? KIND_SOURCE_MAP[kind] : "aurral";
};

export const recordRequestGroupDownloaded = async (requestGroupId: string, filePath: string) => {
  try {
    if (!downloadTracker.isRequestGroupDone(requestGroupId)) return null;
    const request = dbOps.getAlbumRequestByGroup(requestGroupId);
    if (!request || request.statusLabel === "Downloaded") return null;
    return recordAlbumSearchCompleted({
      albumId: request.metadata?.albumId,
      albumName: request.metadata?.albumName,
      artistName: request.metadata?.artistName,
      artistMbid: request.metadata?.artistMbid,
      albumPath: path.dirname(filePath),
      referenceId: albumRequestReferenceId(request),
    });
  } catch (error) {
    return reportRecordFailure(error);
  }
};

const normalizeAlbumMatchText = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const isQueueActive = (queue: AnyQueue, predicate: (payload: JsonObject) => boolean) =>
  queue.list().some(({ payload }) => payload !== null && predicate(payload));

const canViewPlaylistActivity = (
  user: RequesterUser | null | undefined,
  playlistId: unknown,
  ownerUserId: unknown = undefined,
) => {
  if (!user || user.role === "admin") return true;
  if (ownerUserId !== undefined) {
    return ownerUserId != null && Number(ownerUserId) === Number(user.id);
  }
  const id = String(playlistId || "").trim();
  if (!id || id === "library") return true;
  const flow = flowPlaylistConfig.getFlow(id);
  if (flow) return flowPlaylistConfig.canUserAccessFlow(user, flow);
  const playlist = flowPlaylistConfig.getStaticPlaylist(id);
  return playlist ? flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist) : false;
};

const loadPendingPlaylistImportHistory = (user: RequesterUser | null | undefined) => {
  try {
    const rows = playlistOperationQueue.list();
    return rows.flatMap((row) => {
      const { payload } = row;
      if (payload?.kind !== "static-playlist-create") return [];
      if (
        user &&
        user.role !== "admin" &&
        (payload.ownerUserId == null || Number(payload.ownerUserId) !== Number(user.id))
      ) {
        return [];
      }
      const playlistId = String(payload.playlistId || "").trim();
      const playlistName = String(payload.name || "Playlist").trim() || "Playlist";
      const sourceName = String(payload.sourceName || "Playlist import").trim();
      const trackCount = Array.isArray(payload.tracks) ? payload.tracks.length : 0;
      const state = row.state === "running" ? "processing" : "pending";
      const countLabel = `${trackCount} track${trackCount === 1 ? "" : "s"}`;
      return [
        {
          id: stableId("playlist_import", row.id),
          kind: "playlist_import",
          title: state === "processing" ? `Preparing ${playlistName}` : `Queued ${playlistName}`,
          subtitle: `${sourceName} · ${countLabel} ${payload.downloadMissing === false ? "waiting to match" : "waiting for download"}`,
          status: state,
          statusLabel: state === "processing" ? "Preparing" : "Queued",
          href: flowPlaylistConfig.getStaticPlaylist(playlistId)
            ? buildPlaylistHref(playlistId)
            : null,
          metadata: {
            operationId: row.id,
            playlistId,
            playlistName,
            ownerUserId: typeof payload.ownerUserId === "number" ? payload.ownerUserId : null,
            trackCount,
          },
          createdAt: row.created_at,
        },
      ];
    });
  } catch {
    return [];
  }
};

// A release attempt downloads for every track of its album, so a track it
// holds is active while the attempt is.
const isPipelineActiveForJob = (jobId: string) =>
  isQueueActive(
    downloadPipelineQueue,
    (payload) =>
      payload?.jobId === jobId ||
      (Array.isArray(payload?.albumGroupJobIds) && payload.albumGroupJobIds.includes(jobId)),
  );

const buildHistoryJobFromEntry = (entry: AurralHistoryEntry): HistoryJob => ({
  id: entry.metadata?.jobId || entry.id,
  trackName: entry.metadata?.trackName || null,
  artistName: entry.metadata?.artistName || null,
  playlistId: entry.metadata?.playlistId || null,
  playlistType: entry.metadata?.playlistId || null,
  downloadSource: entry.metadata?.downloadSource || null,
});

const loadRecentHistory = () =>
  dbOps.getAurralHistory({ since: Date.now() - MAX_AGE_MS, limit: 300 });

export const syncTrackDownloadHistory = async (
  historyEntries: AurralHistoryEntry[] | null = null,
) => {
  const trackEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) =>
      entry.kind === "track_download" &&
      (entry.status === "processing" || entry.status === "pending" || entry.status === "blocked"),
  );

  for (const entry of trackEntries) {
    const jobId = String(entry.metadata?.jobId || "").trim();
    const isBlocked = entry.status === "blocked";
    const stale = Date.now() - Number(entry.createdAt || 0) >= STALE_TRACK_JOB_MS;
    const fakeJob = buildHistoryJobFromEntry(entry);

    if (!jobId) {
      if (stale) recordTrackJobFailed(fakeJob, "Download no longer active");
      continue;
    }

    const job = downloadTracker.getJob(jobId);
    if (!job) {
      if (isBlocked) recordTrackJobFailed(fakeJob, "Download no longer active");
      else recordTrackJobCancelled(fakeJob);
      continue;
    }

    if (job.status === "done") {
      const isReused = entry.statusLabel === "Queued";
      recordTrackJobCompleted(job, isReused ? "Reused" : "Downloaded");
      continue;
    }
    if (job.status === "failed") {
      recordTrackJobFailed(job, job.error || "Download failed");
      continue;
    }
    if (job.status === "blocked") {
      recordTrackJobBlocked(job, job.error || "Blocked for review");
      continue;
    }
    if (job.status === "cancelled") {
      recordTrackJobCancelled(job);
      continue;
    }
    if (job.status === "cancel_requested") continue;
    if (isBlocked && (job.status === "pending" || job.status === "downloading")) {
      recordTrackJobFailed(job, "Denied by user — will retry");
      continue;
    }
    if (isBlocked) continue;
    if (job.status === "pending") continue;

    const anchorTime = Math.max(
      Number(job.startedAt || 0),
      Number(job.createdAt || 0),
      Number(entry.createdAt || 0),
    );
    if (!anchorTime || Date.now() - anchorTime < STALE_TRACK_JOB_MS) continue;
    if (isPipelineActiveForJob(jobId)) continue;

    const message = "Download timed out";
    downloadTracker.setFailed(jobId, message);
    recordTrackJobFailed(job, message);
  }
};

const syncDiscoveryRefreshHistory = async (historyEntries: AurralHistoryEntry[] | null = null) => {
  const pendingEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) => entry.kind === "discovery_refresh" && entry.status === "processing",
  );
  if (!pendingEntries.length) return;

  const discoveryActive = isQueueActive(discoveryRefreshQueue, () => true);
  if (discoveryActive) return;

  for (const entry of pendingEntries) {
    if (Date.now() - Number(entry.createdAt || 0) < STALE_AURRAL_JOB_MS) continue;
    recordDiscoveryRefreshFailed("Discovery refresh timed out");
  }
};

const syncFlowGenerationHistory = async (historyEntries: AurralHistoryEntry[] | null = null) => {
  const pendingEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) => entry.kind === "flow_generating" && entry.status === "processing",
  );
  if (!pendingEntries.length) return;

  for (const entry of pendingEntries) {
    const flowId = String(entry.metadata?.flowId || "").trim();
    if (!flowId) continue;
    if (Date.now() - Number(entry.createdAt || 0) < STALE_AURRAL_JOB_MS) continue;
    const flowActive = isQueueActive(
      flowRunQueue,
      (payload) => String(payload?.flowId || payload?.playlistId || "").trim() === flowId,
    );
    if (flowActive) continue;
    upsertAurralHistory({
      referenceId: flowId,
      kind: "flow_generating",
      title: `Failed to generate playlist for ${resolvePlaylistName(flowId)}`,
      subtitle: entry.subtitle || null,
      status: "failed",
      statusLabel: "Failed",
      href: buildPlaylistHref(flowId),
      metadata: entry.metadata,
    });
  }
};

export const syncAlbumSearchHistory = async (
  lidarrClient: LidarrClient | null,
  historyEntries: AurralHistoryEntry[] | null = null,
) => {
  if (!lidarrClient?.isConfigured()) return;

  const openEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) =>
      entry.kind === "album_requested" &&
      entry.metadata?.managedBy !== "aurral" &&
      (entry.status === "processing" || entry.status === "failed"),
  );
  if (!openEntries.length) return;

  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue().catch(() => []),
    lidarrClient.getHistory(1, 200).catch(() => []),
    lidarrClient.getCommands().catch(() => []),
  ]);
  const context = parseLidarrSearchContext({ queue, history, commands });

  const resolveMissingAlbumId = async (entry: AurralHistoryEntry) => {
    const albumName = normalizeAlbumMatchText(entry.metadata?.albumName);
    const artistMbid = String(entry.metadata?.artistMbid || "").trim();
    if (!albumName || !artistMbid) return null;
    const artist = await lidarrClient.getArtistByMbid(artistMbid).catch(() => null);
    if (!artist) return null;
    const albums = await lidarrClient.getAllAlbums({ artistIds: [artist.id] }).catch(() => []);
    const match = albums.find((album) => normalizeAlbumMatchText(album?.title) === albumName);
    return match ? String(match.id) : null;
  };

  const resolvedEntries = [];
  for (const entry of openEntries) {
    const albumId = entry.metadata?.albumId
      ? String(entry.metadata.albumId)
      : await resolveMissingAlbumId(entry);
    if (albumId) resolvedEntries.push({ entry, albumId });
  }
  const albums = await getLidarrAlbumsById(
    lidarrClient,
    resolvedEntries.map(({ albumId }) => albumId),
  );

  for (const { entry, albumId } of resolvedEntries) {
    const album = albums.get(albumId);
    if (album === null) {
      // Lidarr answered 404: the album was deleted, so the request is moot.
      dbOps.deleteAurralHistoryById(entry.id);
      continue;
    }
    const albumHasFiles = albumHasTrackFiles(album);
    const outcome = resolveAlbumSearchOutcome(albumId, context, {
      searchStartedAt: entry.createdAt,
      albumHasFiles,
    });
    const referenceId = albumRequestReferenceId(entry);
    const patch = {
      albumId,
      albumName: entry.metadata?.albumName || album?.title,
      artistName: entry.metadata?.artistName || album?.artist?.artistName,
      artistMbid: entry.metadata?.artistMbid || album?.artist?.foreignArtistId,
      referenceId,
    };

    if (outcome?.status === "completed" || albumHasFiles) {
      recordAlbumSearchCompleted(patch);
      continue;
    }
    if (entry.status === "processing" && outcome?.status === "failed") {
      recordAlbumSearchFailed({
        ...patch,
        statusLabel: outcome.statusLabel,
      });
    }
  }
};

const syncActivityFeedHistory = async (lidarrClient: LidarrClient | null = null) => {
  const entries = loadRecentHistory();
  await syncTrackDownloadHistory(entries);
  if (lidarrClient) await syncAlbumSearchHistory(lidarrClient, entries);
};

export const syncProcessingActivityHistory = async (lidarrClient: LidarrClient | null = null) => {
  const entries = loadRecentHistory();
  await syncTrackDownloadHistory(entries);
  await syncDiscoveryRefreshHistory(entries);
  await syncFlowGenerationHistory(entries);
  if (lidarrClient) await syncAlbumSearchHistory(lidarrClient, entries);
};

export interface AurralAlbumGrab {
  id: string;
  memberJobIds: string[];
  phase: string;
  source: string | null;
  fallbackReason: string | null;
  requestedAt: string;
  completedAt?: string | null;
  libraryAlbumId?: string | null;
}

export interface AurralRequestItem {
  id: string;
  source: string;
  type: "activity";
  title: string;
  subtitle: string | null;
  status: string;
  statusLabel: string | null;
  requestedAt: string;
  albumGrab?: AurralAlbumGrab | null;
  completedAt?: string | null;
  actualDownloadSource?: string | null;
  downloadMethod?: string | null;
  previousErrors?: string[];
  trackNumber?: number | null;
  discNumber?: number | null;
  href: string | null;
  kind: string | null;
  playlistId: string | null;
  playlistName: string | null;
  jobId: string | null;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  albumMbid: string | null;
  albumId: string | null;
  libraryAlbumId: string | null;
  requestGroupId: string | null;
  requestedBy: { id: string | number; username: string | null } | null;
  sourceFilename: string | null;
  releaseTitle: string | null;
  upgrade: TrackUpgrade | null;
  inQueue: boolean;
  canReSearch: boolean;
}

type HistoryRequestOptions = {
  sourceFilename?: string | null;
  trackName?: string | null;
  releaseTitle?: string | null;
  albumName?: string | null;
  albumGrab?: AurralAlbumGrab | null;
  libraryAlbumId?: string | null;
  requestGroupId?: string | null;
};

export const toHistoryRequestItem = (
  entry: AurralHistoryEntry,
  options: HistoryRequestOptions = {},
): AurralRequestItem => {
  const kind = entry.kind || null;
  const source = resolveHistorySource(kind, entry.metadata);
  const sourceFilename =
    String(options.sourceFilename || entry.metadata?.sourceFilename || "").trim() || null;
  const trackName = String(options.trackName || entry.metadata?.trackName || "").trim() || null;
  const releaseTitle =
    String(options.releaseTitle || entry.metadata?.releaseTitle || "").trim() || null;
  const albumName = String(options.albumName || entry.metadata?.albumName || "").trim() || null;
  const requester = requesterFromMetadata(entry.metadata);
  return {
    id: entry.id,
    source,
    type: "activity",
    title: entry.title,
    subtitle: entry.subtitle || null,
    status: entry.status || "completed",
    statusLabel: entry.statusLabel || null,
    requestedAt: entry.metadata?.requestedAt || toIso(entry.createdAt),
    ...(options.albumGrab && { albumGrab: options.albumGrab }),
    ...(options.albumGrab && {
      completedAt: entry.metadata?.completedAt || null,
      actualDownloadSource: entry.metadata?.actualDownloadSource || null,
      downloadMethod: entry.metadata?.downloadMethod || null,
      previousErrors: entry.metadata?.previousErrors || [],
      trackNumber: entry.metadata?.trackNumber || null,
      discNumber: entry.metadata?.discNumber || null,
    }),
    href:
      kind === "track_download"
        ? buildTrackJobHref({
            playlistId: entry.metadata?.playlistId,
            albumMbid: entry.metadata?.albumMbid,
          })
        : entry.href || null,
    kind,
    playlistId: entry.metadata?.playlistId || null,
    playlistName: entry.metadata?.playlistName || null,
    jobId: entry.metadata?.jobId || null,
    trackName,
    artistName: entry.metadata?.artistName || null,
    albumName,
    albumMbid: entry.metadata?.albumMbid || null,
    albumId: entry.metadata?.albumId ? String(entry.metadata.albumId) : null,
    libraryAlbumId: options.libraryAlbumId || entry.metadata?.canonicalAlbumId || null,
    requestGroupId: options.requestGroupId || entry.metadata?.requestGroupId || null,
    requestedBy: requester ? { id: requester.userId, username: requester.username || null } : null,
    sourceFilename,
    releaseTitle,
    upgrade: entry.metadata?.upgrade || null,
    inQueue:
      entry.status === "processing" || entry.status === "pending" || entry.status === "blocked",
    canReSearch:
      entry.kind === "album_requested" &&
      entry.status === "failed" &&
      Boolean(entry.metadata?.albumId),
  };
};

const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVE_JOB_STATUSES = new Set(["blocked", "pending", "downloading", "cancel_requested"]);

const buildActiveTrackHistory = (job: HistoryJob | null | undefined): AurralHistoryEntry => {
  const playlistId = job?.playlistId || job?.playlistType;
  const status =
    job?.status === "blocked"
      ? "blocked"
      : job?.status === "downloading" || job?.status === "cancel_requested"
        ? "processing"
        : "pending";
  const statusLabel =
    job?.status === "cancel_requested"
      ? "Cancelling"
      : status === "blocked"
        ? "Review"
        : status === "processing"
          ? "Downloading"
          : "Queued";
  const title =
    job?.status === "cancel_requested"
      ? `Cancelling ${job?.trackName || "track"}`
      : status === "blocked"
        ? `Review needed for ${job?.trackName || "track"}`
        : status === "processing"
          ? `Downloading ${job?.trackName || "track"}${downloadClientSuffix(job)}`
          : `Queued ${job?.trackName || "track"}`;
  return {
    id: stableId("track_download", job?.id),
    kind: "track_download",
    title,
    subtitle:
      status === "blocked"
        ? job?.error || "Blocked for review"
        : `${job?.artistName || "Artist"} · ${resolvePlaylistName(playlistId)}`,
    status,
    statusLabel,
    href: buildTrackJobHref(job),
    metadata: {
      jobId: job?.id,
      trackName: job?.trackName,
      artistName: job?.artistName,
      ...(job?.albumName && { albumName: job.albumName }),
      ...(job?.albumMbid && { albumMbid: job.albumMbid }),
      playlistId,
      downloadSource: job?.downloadSource || null,
      downloadClient: job?.downloadClient || null,
    },
    createdAt: Number(job?.createdAt) || Date.now(),
  };
};

export const getAurralHistoryRequests = async (
  lidarrClient: LidarrClient | null = null,
  user: RequesterUser | null = null,
) => {
  await syncActivityFeedHistory(lidarrClient);
  const entries: AurralHistoryEntry[] = [
    ...loadPendingPlaylistImportHistory(user),
    ...loadRecentHistory(),
  ];
  const entryIds = new Set(entries.map((e) => e.id));

  const jobs = downloadTracker.getAll();
  const activeJobs = jobs.flatMap((job) => {
    const historyId = stableId("track_download", job.id);
    return job.status && ACTIVE_JOB_STATUSES.has(job.status) && !entryIds.has(historyId)
      ? [{ job, historyId }]
      : [];
  });
  const storedEntries = dbOps.getAurralHistoryByIds(activeJobs.map(({ historyId }) => historyId));
  for (const { job, historyId } of activeJobs) {
    const entry = storedEntries.get(historyId) || buildActiveTrackHistory(job);
    if (
      !canViewPlaylistActivity(user, entry.metadata?.playlistId || entry.metadata?.playlistType)
    ) {
      continue;
    }
    entries.push(entry);
    entryIds.add(historyId);
  }

  const now = Date.now();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const canViewEntry = (entry: AurralHistoryEntry) =>
    canViewPlaylistActivity(
      user,
      entry.metadata?.playlistId || entry.metadata?.playlistType,
      entry.metadata?.ownerUserId,
    );
  const expanded = expandAlbumGrabHistory(entries, now - MAX_AGE_MS, canViewEntry);
  const visible = expanded.entries.flatMap((entry) => {
    if (
      ACTIVITY_HIDDEN_KINDS.has(entry.kind) ||
      !canViewEntry(entry) ||
      (entry.status === "failed" && now - entry.createdAt >= FAILED_RETENTION_MS)
    ) {
      return [];
    }
    const jobId = String(entry.metadata?.jobId || "").trim();
    const job = (jobId && jobsById.get(jobId)) || null;
    const albumGrabId = entry.metadata?.albumGrabId;
    const manifest = albumGrabId ? expanded.manifests.get(albumGrabId) : undefined;
    const albumMbid = job?.albumMbid || entry.metadata?.albumMbid || manifest?.albumMbid || null;
    return [{ entry, job, manifest, albumMbid }];
  });
  const queuedAlbums = queuedAlbumGrabs(
    visible.flatMap(({ entry, job, manifest }) =>
      entry.kind === "track_download" && job && !manifest ? [job] : [],
    ),
  );
  const libraryAlbumIds = getLibraryAlbumIdsByReference(
    visible.flatMap(({ entry, albumMbid }) =>
      entry.metadata?.canonicalAlbumId || !albumMbid ? [] : [albumMbid],
    ),
  );
  return visible.map(({ entry, job, manifest: grab, albumMbid }) => {
    const manifest = grab ?? (job ? queuedAlbums.get(job.id) : undefined);
    if (entry.kind === "track_download" && job) {
      entry.metadata = {
        ...entry.metadata,
        downloadSource: job.downloadSource || null,
        downloadClient: job.downloadClient || null,
        trackNumber: entry.metadata?.trackNumber ?? job.trackNumber ?? null,
        discNumber: entry.metadata?.discNumber ?? job.discNumber ?? null,
      };
    }
    const libraryAlbumId =
      entry.metadata?.canonicalAlbumId || (albumMbid && libraryAlbumIds.get(albumMbid)) || null;
    const blockedJob = entry.status === "blocked" ? job : null;
    const sourceFilename =
      (blockedJob && resolveBlockedJobSourceFilename(blockedJob)) || entry.metadata?.sourceFilename;
    const releaseTitle =
      (blockedJob && resolveBlockedJobReleaseTitle(blockedJob)) || entry.metadata?.releaseTitle;
    const albumName =
      entry.metadata?.albumName ||
      (entry.status === "blocked" && job?.albumName ? job.albumName : null);
    const trackName =
      entry.metadata?.trackName ||
      (entry.status === "blocked" && job?.trackName ? job.trackName : null);
    if (entry.kind === "track_download" && job?.status === "cancel_requested") {
      entry.status = "processing";
      entry.statusLabel = "Cancelling";
      entry.title = `Cancelling ${job?.trackName || entry.metadata?.trackName || "track"}`;
    } else if (
      entry.kind === "track_download" &&
      job?.status === "done" &&
      (entry.status === "pending" || entry.status === "processing")
    ) {
      const isReused = entry.statusLabel === "Queued";
      entry.status = "completed";
      entry.statusLabel = isReused ? "Reused" : "Downloaded";
    }
    return toHistoryRequestItem(entry, {
      sourceFilename,
      releaseTitle,
      albumName,
      trackName,
      libraryAlbumId,
      requestGroupId: job?.requestGroupId || manifest?.requestGroupId,
      albumGrab: manifest ? { ...manifest, libraryAlbumId: libraryAlbumId || null } : null,
    });
  });
};
