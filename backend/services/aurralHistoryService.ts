import path from "node:path";
import crypto from "crypto";
import { expandAlbumGrabHistory } from "./albumGrabActivity.ts";
import { dbOps } from "../db/helpers/index.ts";
import { resolveBlockedJobReleaseTitle, resolveBlockedJobSourceFilename } from "./downloadUtils.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { getLibraryForAlbumReferences } from "./libraryQueryService.ts";
import type {
  AurralHistoryEntry,
  AurralHistoryMetadata,
  TrackUpgrade,
} from "../db/helpers/history.ts";
import type { AnyQueue, JsonObject } from "./jobs/queue.ts";
import {
  discoveryRefreshQueue,
  downloadPipelineQueue,
  flowRunQueue,
  playlistOperationQueue,
} from "./jobs/queues.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import type { DownloadJob, JobFields } from "./downloadJobs/downloadTracker.ts";
import type { LidarrClient } from "./lidarrClient.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { albumPath } from "../../lib/albumPath.ts";

type HistoryRequester = { userId: number; username?: string };
type RequesterUser = Pick<RequestUser, "id" | "username" | "role">;

type HistoryMetadata = AurralHistoryMetadata;

type HistoryEntryInput = Partial<Omit<AurralHistoryEntry, "id" | "metadata">> & {
  referenceId?: string | number | null;
  metadata?: HistoryMetadata | null;
};

export type HistoryJob = Pick<DownloadJob, "id"> &
  JobFields<
    | "trackName"
    | "artistName"
    | "albumName"
    | "albumMbid"
    | "playlistId"
    | "playlistType"
    | "requestGroupId"
    | "downloadSource"
    | "downloadClient"
    | "remoteFilename"
    | "stagingPath"
    | "releaseTitle"
    | "status"
    | "error"
    | "createdAt"
    | "startedAt"
  >;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
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

const resolvePlaylistName = (playlistId: string | null | undefined) => {
  const id = String(playlistId || "").trim();
  if (!id) return "Playlist";
  const shared = flowPlaylistConfig.getStaticPlaylist(id);
  if (shared?.name) return shared.name;
  const flow = flowPlaylistConfig.getFlow(id);
  if (flow?.name) return flow.name;
  return id;
};

const buildPlaylistHref = (playlistId: string | null | undefined) => {
  const id = String(playlistId || "").trim();
  if (!id) return "/playlists";
  return `/playlists?selected=${encodeURIComponent(id)}`;
};

const buildTrackJobHref = (
  job: Pick<HistoryJob, "playlistId" | "playlistType" | "albumMbid"> | null | undefined,
) => {
  const playlistId = job?.playlistId || job?.playlistType;
  if (playlistId !== "library") return buildPlaylistHref(playlistId);
  return job?.albumMbid ? albumPath(job.albumMbid) : null;
};

const buildArtistHref = (artistMbid: string | null | undefined) => {
  const mbid = String(artistMbid || "").trim();
  if (!mbid || mbid === "null" || mbid === "undefined") return null;
  return `/artist/${mbid}`;
};

const createId = () => `aurral-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

const stableId = (kind: string, referenceId: string | number | null | undefined) =>
  `aurral-${kind}-${String(referenceId || "").trim()}`;

const toIso = (createdAt: number) => {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) {
    return new Date().toISOString();
  }
  return new Date(value).toISOString();
};

const resolveTrackDownloadHistorySource = (downloadSource: unknown, downloadClient: unknown) => {
  const normalized = String(downloadSource || "")
    .trim()
    .toLowerCase();
  if (normalized === "usenet") {
    const client = String(downloadClient || "")
      .trim()
      .toLowerCase();
    return client === "sabnzbd" || client === "tidarr" ? client : "nzbget";
  }
  if (normalized === "ytdlp") return "ytdlp";
  if (normalized === "deemix") return "deemix";
  if (normalized === "slskd") return "slskd";
  if (normalized === "share") return "share";
  return "unknown";
};

const CLIENT_LABELS = {
  sabnzbd: "SABnzbd",
  nzbget: "NZBGet",
  tidarr: "Tidarr",
  slskd: "slskd",
  ytdlp: "yt-dlp",
  deemix: "deemix",
  share: "Aurral share",
};
const resolveDownloadClientLabel = (downloadSource: unknown, downloadClient: unknown) => {
  const source = resolveTrackDownloadHistorySource(downloadSource, downloadClient);
  return isOwnKey(CLIENT_LABELS, source) ? CLIENT_LABELS[source] : null;
};

const downloadClientSuffix = (job: HistoryJob | null | undefined) => {
  const label = resolveDownloadClientLabel(job?.downloadSource, job?.downloadClient);
  return label ? ` via ${label}` : "";
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

const serializeHistoryMetadata = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
};

type HistoryFields = Pick<
  AurralHistoryEntry,
  "kind" | "title" | "subtitle" | "status" | "statusLabel" | "href" | "metadata"
>;

const hasHistoryRecordChanged = (
  existing: HistoryFields | null | undefined,
  next: HistoryFields,
) => {
  if (!existing) return true;
  return (
    existing.kind !== next.kind ||
    existing.title !== next.title ||
    existing.subtitle !== next.subtitle ||
    existing.status !== next.status ||
    existing.statusLabel !== next.statusLabel ||
    existing.href !== next.href ||
    serializeHistoryMetadata(existing.metadata) !== serializeHistoryMetadata(next.metadata)
  );
};

export const appendAurralHistory = (entry: HistoryEntryInput = {}) => {
  const title = String(entry.title || "").trim();
  if (!title) return null;
  const kind = String(entry.kind || "activity").trim();
  const record = {
    id: createId(),
    kind,
    title,
    subtitle: entry.subtitle ? String(entry.subtitle).trim() : null,
    status: String(entry.status || "completed").trim(),
    statusLabel: entry.statusLabel ? String(entry.statusLabel).trim() : null,
    href: entry.href ? String(entry.href).trim() : null,
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : null,
    createdAt: Number(entry.createdAt) || Date.now(),
  };
  dbOps.insertAurralHistory(record);
  dbOps.pruneAurralHistory({ maxAgeMs: MAX_AGE_MS });
  return record;
};

export const upsertAurralHistory = (entry: HistoryEntryInput = {}) => {
  const title = String(entry.title || "").trim();
  if (!title) return null;
  const referenceId = entry.referenceId ? String(entry.referenceId).trim() : null;
  const kind = String(entry.kind || "activity").trim();
  const id = referenceId ? stableId(kind, referenceId) : createId();
  const existing = dbOps.getAurralHistoryById(id);
  const nextRecord = {
    id,
    kind,
    title,
    subtitle: entry.subtitle ? String(entry.subtitle).trim() : null,
    status: String(entry.status || "completed").trim(),
    statusLabel: entry.statusLabel ? String(entry.statusLabel).trim() : null,
    href: entry.href ? String(entry.href).trim() : null,
    metadata: existing?.metadata?.albumGrabId
      ? { ...existing.metadata, ...entry.metadata }
      : entry.metadata && typeof entry.metadata === "object"
        ? entry.metadata
        : null,
  };
  if (existing && !hasHistoryRecordChanged(existing, nextRecord)) return existing;
  const record = { ...nextRecord, createdAt: Number(entry.createdAt) || Date.now() };
  dbOps.insertAurralHistory(record);
  dbOps.pruneAurralHistory({ maxAgeMs: MAX_AGE_MS });
  return record;
};

export const recordDiscoveryRefreshStarted = () =>
  upsertAurralHistory({
    referenceId: "discovery",
    kind: "discovery_refresh",
    title: "Refreshing discovery",
    subtitle: "Gathering recommendations from your library and listening history",
    status: "processing",
    statusLabel: "Refreshing",
    href: "/",
  });

export const recordDiscoveryUpdated = ({ recommendationCount = 0, genreCount = 0 } = {}) => {
  const parts = [];
  if (recommendationCount > 0) {
    parts.push(`${recommendationCount} recommendation${recommendationCount === 1 ? "" : "s"}`);
  }
  if (genreCount > 0) {
    parts.push(`${genreCount} genre${genreCount === 1 ? "" : "s"}`);
  }
  return upsertAurralHistory({
    referenceId: "discovery",
    kind: "discovery_refresh",
    title: "Discovery updated",
    subtitle: parts.length > 0 ? parts.join(", ") : "Recommendations refreshed",
    status: "completed",
    statusLabel: "Updated",
    href: "/",
    metadata: { recommendationCount, genreCount },
  });
};

export const recordDiscoveryRefreshFailed = (message = "Discovery refresh failed") =>
  upsertAurralHistory({
    referenceId: "discovery",
    kind: "discovery_refresh",
    title: "Discovery refresh failed",
    subtitle: String(message || "").trim() || null,
    status: "failed",
    statusLabel: "Failed",
    href: "/",
  });

export const recordArtistAdded = ({
  artistName,
  artistMbid,
}: { artistName?: string | null; artistMbid?: string | null } = {}) => {
  const mbid = String(artistMbid || "").trim();
  const name = String(artistName || "").trim();
  if (!mbid || !name) return null;
  const id = stableId("artist_added", mbid);
  if (dbOps.getAurralHistoryById(id)) return null;
  return upsertAurralHistory({
    referenceId: mbid,
    kind: "artist_added",
    title: `Added ${name} to library`,
    subtitle: "Artist added via Lidarr",
    status: "completed",
    statusLabel: "Added",
    href: buildArtistHref(mbid),
    metadata: { artistMbid: mbid, artistName: name },
  });
};

const requesterFromUser = (user: RequesterUser | null | undefined): HistoryRequester | null => {
  if (user?.id == null) return null;
  const username = String(user.username || "").trim();
  return { userId: user.id, ...(username && { username }) };
};

const requesterFromMetadata = (
  metadata: HistoryMetadata | null | undefined,
): HistoryRequester | null => {
  if (metadata?.userId == null) return null;
  const username = String(metadata.username || "").trim();
  return {
    userId: metadata.userId,
    ...(username && { username }),
  };
};

const queueRequestNotification = (
  notifyName: "notifyRequestMade" | "notifyRequestAvailable",
  {
    albumName,
    artistName,
    albumPath = null,
    requester,
  }: {
    albumName: string;
    artistName: string;
    albumPath?: string | null;
    requester: HistoryRequester | null;
  },
) => {
  import("./notificationService.ts")
    .then((notifications) =>
      notifications[notifyName]({
        albumName,
        artistName,
        albumPath,
        user: requester ? { id: requester.userId, username: requester.username } : null,
      }),
    )
    .catch((err) => {
      console.warn(`[AurralHistory] ${notifyName} failed:`, err?.message || err);
    });
};

type AlbumRef = {
  albumId?: string | number | null;
  albumName?: string | null;
  artistName?: string | null;
  artistMbid?: string | null;
};

export const recordAlbumRequested = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  managedBy = null,
  requestGroupId = null,
  searching: requestedSearching = false,
  user = null,
}: AlbumRef & {
  managedBy?: string | null;
  requestGroupId?: string | null;
  searching?: boolean;
  user?: RequesterUser | null;
} = {}) => {
  const searching = requestedSearching && managedBy !== "aurral";
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester = requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
  const entry = upsertAurralHistory({
    referenceId: ref,
    kind: "album_requested",
    title: searching ? `Searching Lidarr for ${name}` : `Requested ${name}`,
    subtitle: artist || null,
    status: searching ? "processing" : "completed",
    statusLabel: searching ? "Searching" : "Requested",
    href: buildArtistHref(artistMbid),
    metadata: {
      albumId,
      albumName: name,
      artistName: artist,
      artistMbid,
      ...(managedBy && { managedBy }),
      ...(managedBy === "aurral" && albumId != null && { canonicalAlbumId: String(albumId) }),
      ...(requestGroupId && { requestGroupId }),
      ...requester,
    },
  });
  queueRequestNotification("notifyRequestMade", {
    albumName: name,
    artistName: artist,
    requester,
  });
  return entry;
};

export const recordAlbumSearchStarted = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  user = null,
}: AlbumRef & { user?: RequesterUser | null } = {}) =>
  recordAlbumRequested({
    albumId,
    albumName,
    artistName,
    artistMbid,
    searching: true,
    user,
  });

export const recordMissingTrackSearch = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  queuedTrackCount = 0,
}: AlbumRef & { queuedTrackCount?: number | null } = {}) => {
  const count = Number(queuedTrackCount) || 0;
  if (count <= 0) return null;
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const searchedAt = Date.now();
  return upsertAurralHistory({
    referenceId: String(albumId),
    kind: "missing_track_search",
    title: `Searching again for ${count === 1 ? "1 missing track" : `${count} missing tracks`} on ${name}`,
    subtitle: artist || null,
    status: "completed",
    statusLabel: "Queued",
    href: buildArtistHref(artistMbid),
    metadata: {
      albumId,
      albumName: name,
      artistName: artist,
      artistMbid,
      queuedTrackCount: count,
      searchedAt,
    },
    createdAt: searchedAt,
  });
};

export const recordAlbumSearchFailed = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  statusLabel = "Not found",
  user = null,
  referenceId = null,
}: AlbumRef & {
  statusLabel?: string;
  user?: RequesterUser | null;
  referenceId?: string | null;
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(referenceId || albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester = requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
  return upsertAurralHistory({
    referenceId: ref,
    kind: "album_requested",
    title: `No results for ${name}`,
    subtitle: artist || null,
    status: "failed",
    statusLabel,
    href: buildArtistHref(artistMbid),
    metadata: {
      albumId,
      albumName: name,
      artistName: artist,
      artistMbid,
      ...requester,
    },
  });
};

export const recordAlbumSearchCompleted = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  albumPath = null,
  user = null,
  referenceId = null,
}: AlbumRef & {
  albumPath?: string | null;
  user?: RequesterUser | null;
  referenceId?: string | null;
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(referenceId || albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester = requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
  const alreadyAvailable = existing?.statusLabel === "Downloaded";
  const entry = upsertAurralHistory({
    referenceId: ref,
    kind: "album_requested",
    title: `Downloaded ${name}`,
    subtitle: artist || null,
    status: "completed",
    statusLabel: "Downloaded",
    href: buildArtistHref(artistMbid),
    metadata: {
      ...existing?.metadata,
      albumId,
      albumName: name,
      artistName: artist,
      artistMbid,
      ...requester,
    },
  });
  if (!alreadyAvailable) {
    queueRequestNotification("notifyRequestAvailable", {
      albumName: name,
      artistName: artist,
      albumPath,
      requester,
    });
  }
  return entry;
};

export const recordRequestGroupDownloaded = async (requestGroupId: string, filePath: string) => {
  const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
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
};

const albumRequestReferenceId = (entry: AurralHistoryEntry) => {
  const prefix = "aurral-album_requested-";
  if (typeof entry?.id === "string" && entry.id.startsWith(prefix)) {
    return entry.id.slice(prefix.length);
  }
  return String(entry?.metadata?.albumId || entry?.metadata?.artistMbid || "").trim();
};

export const recordAlbumImportCompleted = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
}: AlbumRef = {}) => {
  const normalizedAlbumId = String(albumId ?? "").trim();
  if (!normalizedAlbumId) return null;

  const stableEntry = dbOps.getAurralHistoryById(stableId("album_requested", normalizedAlbumId));
  const existing =
    stableEntry?.kind === "album_requested"
      ? stableEntry
      : dbOps
          .getAurralHistory({ since: Date.now() - MAX_AGE_MS, limit: 300 })
          .find(
            (entry) =>
              entry.kind === "album_requested" &&
              String(entry.metadata?.albumId ?? "").trim() === normalizedAlbumId,
          );
  if (!existing || existing.kind !== "album_requested") return null;
  if (existing.statusLabel === "Downloaded") return existing;

  return recordAlbumSearchCompleted({
    albumId: normalizedAlbumId,
    albumName: albumName || existing.metadata?.albumName,
    artistName: artistName || existing.metadata?.artistName,
    artistMbid: artistMbid || existing.metadata?.artistMbid,
    referenceId: albumRequestReferenceId(existing),
  });
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
  const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
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

  const {
    parseLidarrSearchContext,
    resolveAlbumSearchOutcome,
    albumHasTrackFiles,
    getLidarrAlbumsById,
  } = await import("./albumSearchState.ts");
  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue().catch(() => []),
    lidarrClient.getHistory(1, 200).catch(() => ({ records: [] })),
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

export const recordFlowGenerationStarted = ({ flowId }: { flowId?: string | null } = {}) => {
  const id = String(flowId || "").trim();
  if (!id) return null;
  const flowName = resolvePlaylistName(id);
  return upsertAurralHistory({
    referenceId: id,
    kind: "flow_generating",
    title: `Generating playlist for ${flowName}`,
    subtitle: "Building tracklist from discovery sources",
    status: "processing",
    statusLabel: "Generating",
    href: buildPlaylistHref(id),
    metadata: { flowId: id },
  });
};

export const recordFlowTracksGenerated = ({
  flowId,
  tracksQueued = 0,
  tracksFound = 0,
}: { flowId?: string | null; tracksQueued?: number; tracksFound?: number } = {}) => {
  const id = String(flowId || "").trim();
  const count = tracksQueued || tracksFound;
  if (!id || count <= 0) return null;
  const flowName = resolvePlaylistName(id);
  const tracks = count === 1 ? "1 track" : `${count} tracks`;
  return upsertAurralHistory({
    referenceId: id,
    kind: "flow_generating",
    title: `Generated playlist for ${flowName}`,
    subtitle: tracksQueued > 0 ? `${tracks} queued for download` : `${tracks} found`,
    status: "completed",
    statusLabel: "Generated",
    href: buildPlaylistHref(id),
    metadata: { flowId: id, tracksQueued },
  });
};

export const recordPlaylistTracksAdded = ({
  playlistId,
  tracksQueued = 0,
  tracksReused = 0,
}: { playlistId?: string | null; tracksQueued?: number; tracksReused?: number } = {}) => {
  const total = tracksQueued + tracksReused;
  if (total <= 0) return null;
  const playlistName = resolvePlaylistName(playlistId);
  const title =
    total === 1 ? `Added 1 track to ${playlistName}` : `Added ${total} tracks to ${playlistName}`;
  const subtitleParts = [];
  if (tracksReused > 0) {
    subtitleParts.push(`${tracksReused} from library`);
  }
  if (tracksQueued > 0) {
    subtitleParts.push(`${tracksQueued} queued for download`);
  }
  return appendAurralHistory({
    kind: "playlist_tracks_added",
    title,
    subtitle: subtitleParts.join(" · ") || playlistName,
    status: "completed",
    statusLabel: "Added",
    href: buildPlaylistHref(playlistId),
    metadata: { playlistId, tracksQueued, tracksReused },
  });
};

export const recordTrackReused = ({
  track = {},
  playlistId,
  sourceType = "library",
}: {
  track?: {
    trackName?: string | null;
    title?: string | null;
    artistName?: string | null;
    artist?: string | null;
  };
  playlistId?: string | null;
  sourceType?: string;
} = {}) => {
  const playlistName = resolvePlaylistName(playlistId);
  const trackName = String(track.trackName || track.title || "Track").trim();
  const artistName = String(track.artistName || track.artist || "Artist").trim();
  const fromLabel =
    sourceType === "lidarr"
      ? "from Lidarr library"
      : sourceType === "aurral"
        ? "from Aurral library"
        : "from library";
  return appendAurralHistory({
    kind: sourceType === "lidarr" ? "track_reused_lidarr" : "track_reused_aurral",
    title: `Reused ${trackName}`,
    subtitle: `${artistName} · ${playlistName} · ${fromLabel}`,
    status: "completed",
    statusLabel: sourceType === "lidarr" ? "From Lidarr" : "From library",
    href: buildPlaylistHref(playlistId),
    metadata: {
      playlistId,
      sourceType,
      artistName,
      trackName,
    },
  });
};

type TrackJobActivityInput = {
  jobId?: string | null;
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  albumMbid?: string | null;
  requestGroupId?: string | null;
  playlistId?: string | null;
  downloadSource?: string | null;
  downloadClient?: string | null;
  status?: string;
  statusLabel?: string;
  title?: string | null;
  subtitle?: string | null;
  sourceFilename?: string | null;
  releaseTitle?: string | null;
  user?: RequesterUser | null;
  href?: string | null;
  upgrade?: TrackUpgrade | null;
};

export const recordTrackJobActivity = ({
  jobId,
  trackName,
  artistName,
  albumName = null,
  playlistId,
  status = "processing",
  statusLabel = "Searching",
  title = null,
  subtitle = null,
  downloadSource = null,
  downloadClient = null,
  sourceFilename = null,
  releaseTitle = null,
  albumMbid = null,
  requestGroupId = null,
  user = null,
  href = null,
  upgrade = null,
}: TrackJobActivityInput = {}) => {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const playlistName = resolvePlaylistName(playlistId);
  const track = String(trackName || "Track").trim();
  const artist = String(artistName || "Artist").trim();
  const album = String(albumName || "").trim() || null;
  const clientLabel = resolveDownloadClientLabel(downloadSource, downloadClient);
  const filename = String(sourceFilename || "").trim() || null;
  const release = String(releaseTitle || "").trim() || null;
  const previous = dbOps.getAurralHistoryById(stableId("track_download", id));
  const requester = requesterFromMetadata(previous?.metadata) || requesterFromUser(user);
  const groupId = requestGroupId || previous?.metadata?.requestGroupId || null;
  const trackUpgrade = upgrade || previous?.metadata?.upgrade || null;
  return upsertAurralHistory({
    referenceId: id,
    kind: "track_download",
    title: title || `Searching ${clientLabel ? `${clientLabel} ` : ""}for ${track}`,
    subtitle: subtitle || `${artist} · ${playlistName}`,
    status,
    statusLabel,
    href: href || buildTrackJobHref({ playlistType: playlistId, albumMbid }),
    metadata: {
      jobId: id,
      trackName: track,
      artistName: artist,
      ...(album && { albumName: album }),
      playlistId,
      downloadSource: downloadSource || null,
      downloadClient: downloadClient || null,
      ...(albumMbid && { albumMbid }),
      ...(groupId && { requestGroupId: groupId }),
      ...requester,
      ...(filename && { sourceFilename: filename }),
      ...(release && { releaseTitle: release }),
      ...(trackUpgrade && { upgrade: trackUpgrade }),
    },
  });
};

const trackJobFields = (job: HistoryJob | null | undefined) => ({
  jobId: job?.id,
  trackName: job?.trackName,
  artistName: job?.artistName,
  albumName: job?.albumName,
  albumMbid: job?.albumMbid,
  requestGroupId: job?.requestGroupId,
  playlistId: job?.playlistId || job?.playlistType,
  downloadSource: job?.downloadSource,
  downloadClient: job?.downloadClient,
  href: buildTrackJobHref(job),
});

const recordTrackJob = (job: HistoryJob | null | undefined, patch: TrackJobActivityInput) =>
  recordTrackJobActivity({ ...trackJobFields(job), ...patch });

export const recordTrackJobSearching = (job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Searching",
  });

export const getTrackJobRequesterId = (jobId: string) =>
  requesterFromMetadata(dbOps.getAurralHistoryById(stableId("track_download", jobId))?.metadata)
    ?.userId ?? null;

export const recordTrackJobQueued = (
  job: HistoryJob | null | undefined,
  user: RequesterUser | null = null,
  upgrade: TrackUpgrade | null = null,
) => {
  const jobId = String(job?.id || "").trim();
  if (!jobId) return null;
  const existing = dbOps.getAurralHistoryById(stableId("track_download", jobId));
  if (existing) {
    if (user?.id != null && existing.metadata?.userId == null) {
      dbOps.insertAurralHistory({
        ...existing,
        metadata: { ...existing.metadata, ...requesterFromUser(user) },
      });
    }
    return null;
  }
  return recordTrackJob(job, {
    user,
    upgrade,
    status: "pending",
    statusLabel: "Queued",
    title: `Queued ${job?.trackName || "track"}`,
  });
};

export const recordTrackJobDownloading = (job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Downloading",
    title: `Downloading ${job?.trackName || "track"}${downloadClientSuffix(job)}`,
  });

export const recordTrackJobWaiting = (job: HistoryJob | null | undefined, reason: string) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Waiting",
    title: `Waiting to download ${job?.trackName || "track"}${downloadClientSuffix(job)}`,
    subtitle: reason,
  });

export const recordTrackJobMoving = (job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Moving",
    title: `Moving ${job?.trackName || "track"} into playlist library`,
  });

export const recordTrackJobCompleted = (
  job: HistoryJob | null | undefined,
  statusLabel = "Downloaded",
) =>
  recordTrackJob(job, {
    status: "completed",
    statusLabel,
    title: `${statusLabel === "Reused" ? "Reused" : "Downloaded"} ${job?.trackName || "track"}`,
    subtitle: `${job?.artistName || "Artist"} · ${resolvePlaylistName(job?.playlistId || job?.playlistType)}`,
  });

export const recordTrackJobFailed = (
  job: HistoryJob | null | undefined,
  message = "Download failed",
) =>
  recordTrackJob(job, {
    status: "failed",
    statusLabel: "Failed",
    title: `Failed to download ${job?.trackName || "track"}`,
    subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
  });

export const recordTrackJobCancelled = (job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "cancelled",
    statusLabel: "Cancelled",
    title: `Cancelled ${job?.trackName || "track"}`,
  });

export const recordTrackJobBlocked = (job: HistoryJob, message = "Blocked for review") =>
  recordTrackJob(job, {
    status: "blocked",
    statusLabel: "Review",
    title: `Review needed for ${job?.trackName || "track"}`,
    subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
    sourceFilename: resolveBlockedJobSourceFilename(job),
    releaseTitle: resolveBlockedJobReleaseTitle(job),
  });

export interface AurralAlbumGrab {
  id: string;
  memberJobIds: string[];
  phase: string;
  source: string | null;
  fallbackReason: string | null;
  requestedAt: string;
  completedAt?: string | null;
  libraryAlbumId?: string | null;
  canonicalAlbumId?: string | null;
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
  canonicalAlbumId: string | null;
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

const libraryAlbumIds = (libraryAlbumId: string | null | undefined) => ({
  libraryAlbumId: libraryAlbumId || null,
  canonicalAlbumId: libraryAlbumId || null,
});

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
    ...libraryAlbumIds(options.libraryAlbumId || entry.metadata?.canonicalAlbumId || null),
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

  const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
  const jobs: HistoryJob[] = downloadTracker.getAll();
  for (const job of jobs) {
    if (
      job.status !== "blocked" &&
      job.status !== "pending" &&
      job.status !== "downloading" &&
      job.status !== "cancel_requested"
    ) {
      continue;
    }
    const historyId = stableId("track_download", job.id);
    if (entryIds.has(historyId)) continue;
    const row = dbOps.getAurralHistoryById(historyId);
    const entry = row || buildActiveTrackHistory(job);
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
  const libraryAlbumIdsByMbid = new Map<unknown, string | null>();
  const resolveLibraryAlbumId = (albumMbid: unknown) => {
    if (!albumMbid) return null;
    if (!libraryAlbumIdsByMbid.has(albumMbid)) {
      const album = getLibraryForAlbumReferences({ source: "all", references: [albumMbid] })
        .albums[0];
      libraryAlbumIdsByMbid.set(albumMbid, album?.id != null ? String(album.id) : null);
    }
    return libraryAlbumIdsByMbid.get(albumMbid);
  };
  const canViewEntry = (entry: AurralHistoryEntry) =>
    canViewPlaylistActivity(
      user,
      entry.metadata?.playlistId || entry.metadata?.playlistType,
      entry.metadata?.ownerUserId,
    );
  const expanded = expandAlbumGrabHistory(entries, now - MAX_AGE_MS, canViewEntry);
  return expanded.entries
    .filter(
      (e) =>
        !ACTIVITY_HIDDEN_KINDS.has(e.kind) &&
        canViewEntry(e) &&
        (e.status !== "failed" || now - e.createdAt < FAILED_RETENTION_MS),
    )
    .map((entry) => {
      const jobId = String(entry.metadata?.jobId || "").trim();
      const job = jobId ? jobsById.get(jobId) : null;
      if (entry.kind === "track_download" && job) {
        entry.metadata = {
          ...entry.metadata,
          downloadSource: job.downloadSource || null,
          downloadClient: job.downloadClient || null,
        };
      }
      const albumGrabId = entry.metadata?.albumGrabId;
      const manifest = albumGrabId ? expanded.manifests.get(albumGrabId) : undefined;
      const libraryAlbumId =
        entry.metadata?.canonicalAlbumId ||
        resolveLibraryAlbumId(job?.albumMbid || entry.metadata?.albumMbid || manifest?.albumMbid);
      const blockedJob = entry.status === "blocked" ? job : null;
      const sourceFilename =
        (blockedJob && resolveBlockedJobSourceFilename(blockedJob)) ||
        entry.metadata?.sourceFilename;
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
        albumGrab: manifest ? { ...manifest, ...libraryAlbumIds(libraryAlbumId) } : null,
      });
    });
};
