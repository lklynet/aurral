import crypto from "crypto";
import { dbOps } from "../db/helpers/index.js";
import { resolveBlockedJobSourceFilename } from "./playlistDownloadUtils.js";
import { flowPlaylistConfig } from "./weeklyFlow/weeklyFlowPlaylistConfig.js";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_TRACK_JOB_MS = 15 * 60 * 1000;
const STALE_AURRAL_JOB_MS = 60 * 60 * 1000;

const KIND_SOURCE_MAP = {
  track_download: "slskd",
  album_requested: "lidarr",
  artist_added: "lidarr",
  track_reused_lidarr: "lidarr",
  track_reused_aurral: "aurral",
  discovery_refresh: "aurral",
  flow_generating: "aurral",
  playlist_tracks_added: "aurral",
};

const ACTIVITY_HIDDEN_KINDS = new Set([
  "discovery_refresh",
  "flow_generating",
  "playlist_tracks_added",
  "track_reused_aurral",
]);

const resolvePlaylistName = (playlistId) => {
  const id = String(playlistId || "").trim();
  if (!id) return "Playlist";
  const shared = flowPlaylistConfig.getSharedPlaylist(id);
  if (shared?.name) return shared.name;
  const flow = flowPlaylistConfig.getFlow(id);
  if (flow?.name) return flow.name;
  return id;
};

const buildPlaylistHref = (playlistId) => {
  const id = String(playlistId || "").trim();
  if (!id) return "/playlists";
  return `/playlists?selected=${encodeURIComponent(id)}`;
};

const buildArtistHref = (artistMbid) => {
  const mbid = String(artistMbid || "").trim();
  if (!mbid || mbid === "null" || mbid === "undefined") return null;
  return `/artist/${mbid}`;
};

const createId = () => `aurral-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

const stableId = (kind, referenceId) => `aurral-${kind}-${String(referenceId || "").trim()}`;

const toIso = (createdAt) => {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) {
    return new Date().toISOString();
  }
  return new Date(value).toISOString();
};

const resolveTrackDownloadHistorySource = (downloadSource, downloadClient) => {
  const normalized = String(downloadSource || "")
    .trim()
    .toLowerCase();
  if (normalized === "usenet") {
    const client = String(downloadClient || "").trim().toLowerCase();
    if (client === "sabnzbd") return "sabnzbd";
    return "nzbget";
  }
  if (normalized === "ytdlp") return "ytdlp";
  if (normalized === "deemix") return "deemix";
  return "slskd";
};

const CLIENT_LABELS = {
  sabnzbd: "SABnzbd",
  nzbget: "NZBGet",
  slskd: "slskd",
  ytdlp: "yt-dlp",
  deemix: "deemix",
};
const resolveDownloadClientLabel = (downloadSource, downloadClient) =>
  CLIENT_LABELS[resolveTrackDownloadHistorySource(downloadSource, downloadClient)] || "slskd";

const resolveHistorySource = (kind, metadata = null) => {
  if (kind === "track_download") {
    return resolveTrackDownloadHistorySource(metadata?.downloadSource, metadata?.downloadClient);
  }
  return KIND_SOURCE_MAP[kind] || "aurral";
};

const serializeHistoryMetadata = (value) => {
  if (!value || typeof value !== "object") return null;
  return JSON.stringify(value);
};

const hasHistoryRecordChanged = (existing, next) => {
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

export const appendAurralHistory = (entry = {}) => {
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

export const upsertAurralHistory = (entry = {}) => {
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
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : null,
  };
  const changed = hasHistoryRecordChanged(existing, nextRecord);
  const record = {
    ...nextRecord,
    createdAt: existing
      ? changed
        ? Number(entry.createdAt) || Date.now()
        : existing.createdAt
      : Number(entry.createdAt) || Date.now(),
  };
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
    href: "/discover",
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
    href: "/discover",
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
    href: "/discover",
  });

export const recordArtistAdded = ({ artistName, artistMbid } = {}) => {
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

const requesterFromUser = (user) => {
  if (user?.id == null) return null;
  const username = String(user.username || "").trim();
  return { userId: user.id, ...(username ? { username } : {}) };
};

const requesterFromMetadata = (metadata) => {
  if (metadata?.userId == null) return null;
  const username = String(metadata.username || "").trim();
  return {
    userId: metadata.userId,
    ...(username ? { username } : {}),
  };
};

const queueRequestNotification = (notifyName, { albumName, artistName, requester }) => {
  import("./notificationService.js")
    .then((notifications) =>
      notifications[notifyName]({
        albumName,
        artistName,
        user: requester
          ? { id: requester.userId, username: requester.username }
          : null,
      }),
    )
    .catch((err) => {
      console.warn(`[AurralHistory] ${notifyName} failed:`, err?.message || err);
    });
};

export const recordAlbumRequested = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  searching = false,
  user = null,
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester =
    requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
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
} = {}) =>
  recordAlbumRequested({
    albumId,
    albumName,
    artistName,
    artistMbid,
    searching: true,
    user,
  });

export const recordAlbumSearchFailed = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  statusLabel = "Not found",
  user = null,
  referenceId = null,
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(referenceId || albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester =
    requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
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
  user = null,
  referenceId = null,
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(referenceId || albumId || artistMbid || name).trim();
  if (!ref) return null;
  const existing = dbOps.getAurralHistoryById(stableId("album_requested", ref));
  const requester =
    requesterFromUser(user) || requesterFromMetadata(existing?.metadata);
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
      requester,
    });
  }
  return entry;
};

const albumRequestReferenceId = (entry) => {
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
} = {}) => {
  const normalizedAlbumId = String(albumId ?? "").trim();
  if (!normalizedAlbumId) return null;

  const stableEntry = dbOps.getAurralHistoryById(
    stableId("album_requested", normalizedAlbumId),
  );
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

const normalizeAlbumMatchText = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const parseHonkerPayload = (value) => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const isHonkerQueueActive = async (queueName, predicate) => {
  try {
    const { getHonkerDb } = await import("./honkerDb.js");
    const rows = getHonkerDb().query(
      `
        SELECT payload
        FROM _honker_live
        WHERE queue = ?
          AND state IN ('pending', 'processing')
      `,
      [String(queueName || "").trim()],
    );
    for (const row of rows) {
      const payload = parseHonkerPayload(row?.payload);
      if (payload && predicate(payload)) return true;
    }
    return false;
  } catch {
    return false;
  }
};

const canViewPlaylistActivity = (user, playlistId, ownerUserId = undefined) => {
  if (!user || user.role === "admin") return true;
  if (ownerUserId !== undefined) {
    return ownerUserId != null && Number(ownerUserId) === Number(user.id);
  }
  const id = String(playlistId || "").trim();
  if (!id || id === "library") return true;
  const flow = flowPlaylistConfig.getFlow(id);
  if (flow) return flowPlaylistConfig.canUserAccessFlow(user, flow);
  const playlist = flowPlaylistConfig.getSharedPlaylist(id);
  return playlist ? flowPlaylistConfig.canUserAccessSharedPlaylist(user, playlist) : false;
};

const loadPendingPlaylistImportHistory = async (user) => {
  try {
    const { getHonkerDb } = await import("./honkerDb.js");
    const rows = getHonkerDb().query(
      `
        SELECT id, payload, state, created_at
        FROM _honker_live
        WHERE queue = ?
          AND state IN ('pending', 'processing')
        ORDER BY created_at ASC, id ASC
      `,
      ["weekly-flow-operation"],
    );
    return rows.flatMap((row) => {
      const payload = parseHonkerPayload(row?.payload);
      if (payload?.kind !== "shared-playlist-create") return [];
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
      const state = row.state === "processing" ? "processing" : "pending";
      const countLabel = `${trackCount} track${trackCount === 1 ? "" : "s"}`;
      const createdAt = Number(row.created_at);
      return [
        {
          id: stableId("playlist_import", row.id),
          kind: "playlist_import",
          title: state === "processing" ? `Preparing ${playlistName}` : `Queued ${playlistName}`,
          subtitle: `${sourceName} · ${countLabel} waiting for download`,
          status: state,
          statusLabel: state === "processing" ? "Preparing" : "Queued",
          href: flowPlaylistConfig.getSharedPlaylist(playlistId)
            ? buildPlaylistHref(playlistId)
            : null,
          metadata: {
            operationId: row.id,
            playlistId,
            playlistName,
            ownerUserId: payload.ownerUserId ?? null,
            trackCount,
          },
          createdAt:
            Number.isFinite(createdAt) && createdAt > 0
              ? createdAt > 1e12
                ? createdAt
                : createdAt * 1000
              : Date.now(),
        },
      ];
    });
  } catch {
    return [];
  }
};

const isPipelineActiveForJob = async (jobId) =>
  isHonkerQueueActive("slskd-pipeline", (payload) => payload?.jobId === jobId);

const buildHistoryJobFromEntry = (entry) => ({
  id: entry.metadata?.jobId || entry.id,
  trackName: entry.metadata?.trackName || null,
  artistName: entry.metadata?.artistName || null,
  playlistId: entry.metadata?.playlistId || null,
  playlistType: entry.metadata?.playlistId || null,
  downloadSource: entry.metadata?.downloadSource || null,
});

const loadRecentHistory = () =>
  dbOps.getAurralHistory({ since: Date.now() - MAX_AGE_MS, limit: 300 });

export const syncTrackDownloadHistory = async (historyEntries = null) => {
  const { downloadTracker } = await import("./weeklyFlow/weeklyFlowDownloadTracker.js");
  const trackEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) =>
      entry.kind === "track_download" &&
      (entry.status === "processing" ||
        entry.status === "pending" ||
        entry.status === "blocked"),
  );

  const historyJobIds = new Set(
    trackEntries.map((entry) => entry.metadata?.jobId).filter(Boolean),
  );
  for (const job of downloadTracker.getByStatus("blocked")) {
    if (historyJobIds.has(job.id)) continue;
    recordTrackJobBlocked(job, job.error || "Blocked for review");
  }

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
      if (isBlocked || stale) {
        recordTrackJobFailed(fakeJob, "Download no longer active");
      }
      continue;
    }

    if (job.status === "done") {
      recordTrackJobCompleted(job);
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
    if (await isPipelineActiveForJob(jobId)) continue;

    const message = "Download timed out";
    downloadTracker.setFailed(jobId, message);
    recordTrackJobFailed(job, message);
  }
};

const syncDiscoveryRefreshHistory = async (historyEntries = null) => {
  const pendingEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) => entry.kind === "discovery_refresh" && entry.status === "processing",
  );
  if (!pendingEntries.length) return;

  const discoveryActive = await isHonkerQueueActive("discovery-refresh", () => true);
  if (discoveryActive) return;

  for (const entry of pendingEntries) {
    if (Date.now() - Number(entry.createdAt || 0) < STALE_AURRAL_JOB_MS) continue;
    recordDiscoveryRefreshFailed("Discovery refresh timed out");
  }
};

const syncFlowGenerationHistory = async (historyEntries = null) => {
  const pendingEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) => entry.kind === "flow_generating" && entry.status === "processing",
  );
  if (!pendingEntries.length) return;

  for (const entry of pendingEntries) {
    const flowId = String(entry.metadata?.flowId || "").trim();
    if (!flowId) continue;
    if (Date.now() - Number(entry.createdAt || 0) < STALE_AURRAL_JOB_MS) continue;
    const flowActive = await isHonkerQueueActive(
      "weekly-flow-operation",
      (payload) =>
        String(payload?.flowId || payload?.playlistId || "").trim() === flowId,
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

export const syncAlbumSearchHistory = async (lidarrClient, historyEntries = null) => {
  if (!lidarrClient?.isConfigured()) return;

  const openEntries = (historyEntries || loadRecentHistory()).filter(
    (entry) =>
      entry.kind === "album_requested" &&
      (entry.status === "processing" || entry.status === "failed"),
  );
  if (!openEntries.length) return;

  const { parseLidarrSearchContext, resolveAlbumSearchOutcome, albumHasTrackFiles } =
    await import("./albumSearchState.js");
  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue().catch(() => []),
    lidarrClient.getHistory(1, 200).catch(() => ({ records: [] })),
    lidarrClient.request("/command").catch(() => []),
  ]);
  const context = parseLidarrSearchContext({ queue, history, commands });

  let lidarrAlbums = null;
  const loadLidarrAlbums = async () => {
    if (lidarrAlbums) return lidarrAlbums;
    lidarrAlbums = await lidarrClient.request("/album").catch(() => []);
    if (!Array.isArray(lidarrAlbums)) lidarrAlbums = [];
    return lidarrAlbums;
  };

  const resolveMissingAlbumId = async (entry) => {
    const albumName = normalizeAlbumMatchText(entry.metadata?.albumName);
    const artistName = normalizeAlbumMatchText(entry.metadata?.artistName);
    if (!albumName || !artistName) return null;
    const albums = await loadLidarrAlbums();
    const match = albums.find((album) => {
      const title = normalizeAlbumMatchText(album?.title);
      const artist = normalizeAlbumMatchText(album?.artist?.artistName);
      return title === albumName && artist === artistName;
    });
    return match?.id != null ? String(match.id) : null;
  };

  for (const entry of openEntries) {
    let albumId = entry.metadata?.albumId ? String(entry.metadata.albumId) : null;
    if (!albumId) {
      albumId = await resolveMissingAlbumId(entry);
    }
    if (!albumId) continue;

    const album = await lidarrClient.getAlbum(albumId).catch(() => null);
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

const syncActivityFeedHistory = async (lidarrClient = null) => {
  const entries = loadRecentHistory();
  await syncTrackDownloadHistory(entries);
  if (lidarrClient) await syncAlbumSearchHistory(lidarrClient, entries);
};

export const syncProcessingActivityHistory = async (lidarrClient = null) => {
  const entries = loadRecentHistory();
  await syncTrackDownloadHistory(entries);
  await syncDiscoveryRefreshHistory(entries);
  await syncFlowGenerationHistory(entries);
  if (lidarrClient) await syncAlbumSearchHistory(lidarrClient, entries);
};

export const recordFlowGenerationStarted = ({ flowId } = {}) => {
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

export const recordFlowTracksGenerated = ({ flowId, tracksQueued = 0, reserveTracks = 0 } = {}) => {
  const id = String(flowId || "").trim();
  if (!id) return null;
  const total = tracksQueued + reserveTracks;
  if (total <= 0) return null;
  const flowName = resolvePlaylistName(id);
  return upsertAurralHistory({
    referenceId: id,
    kind: "flow_generating",
    title: `Generated playlist for ${flowName}`,
    subtitle:
      reserveTracks > 0
        ? `${total} tracks · ${tracksQueued} queued · ${reserveTracks} in reserve`
        : total === 1
          ? "1 track queued for download"
          : `${total} tracks queued for download`,
    status: "completed",
    statusLabel: "Generated",
    href: buildPlaylistHref(id),
    metadata: { flowId: id, tracksQueued, reserveTracks },
  });
};

export const recordPlaylistTracksAdded = ({
  playlistId,
  tracksQueued = 0,
  tracksReused = 0,
} = {}) => {
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

export const recordTrackReused = ({ track = {}, playlistId, sourceType = "library" } = {}) => {
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
} = {}) => {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const playlistName = resolvePlaylistName(playlistId);
  const track = String(trackName || "Track").trim();
  const artist = String(artistName || "Artist").trim();
  const album = String(albumName || "").trim() || null;
  const clientLabel = resolveDownloadClientLabel(downloadSource, downloadClient);
  const filename = String(sourceFilename || "").trim() || null;
  return upsertAurralHistory({
    referenceId: id,
    kind: "track_download",
    title: title || `Searching ${clientLabel} for ${track}`,
    subtitle: subtitle || `${artist} · ${playlistName}`,
    status,
    statusLabel,
    href: buildPlaylistHref(playlistId),
    metadata: {
      jobId: id,
      trackName: track,
      artistName: artist,
      ...(album ? { albumName: album } : {}),
      playlistId,
      downloadSource: downloadSource || "slskd",
      downloadClient: downloadClient || null,
      ...(filename ? { sourceFilename: filename } : {}),
    },
  });
};

const trackJobFields = (job) => ({
  jobId: job?.id,
  trackName: job?.trackName,
  artistName: job?.artistName,
  albumName: job?.albumName,
  playlistId: job?.playlistId || job?.playlistType,
  downloadSource: job?.downloadSource,
  downloadClient: job?.downloadClient,
});

const recordTrackJob = (job, patch) =>
  recordTrackJobActivity({ ...trackJobFields(job), ...patch });

export const recordTrackJobSearching = (job) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Searching",
    title: `Searching ${resolveDownloadClientLabel(job?.downloadSource, job?.downloadClient)} for ${job?.trackName || "track"}`,
  });

export const recordTrackJobQueued = (job) => {
  const jobId = String(job?.id || "").trim();
  if (!jobId || dbOps.getAurralHistoryById(stableId("track_download", jobId))) return null;
  return recordTrackJob(job, {
    status: "pending",
    statusLabel: "Queued",
    title: `Queued ${job?.trackName || "track"}`,
  });
};

export const recordTrackJobDownloading = (job) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Downloading",
    title: `Downloading ${job?.trackName || "track"} via ${resolveDownloadClientLabel(job?.downloadSource, job?.downloadClient)}`,
  });

export const recordTrackJobMoving = (job) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Moving",
    title: `Moving ${job?.trackName || "track"} into playlist library`,
  });

export const recordTrackJobCompleted = (job) =>
  recordTrackJob(job, {
    status: "completed",
    statusLabel: "Downloaded",
    title: `Downloaded ${job?.trackName || "track"}`,
    subtitle: `${job?.artistName || "Artist"} · ${resolvePlaylistName(job?.playlistId || job?.playlistType)}`,
  });

export const recordTrackJobFailed = (job, message = "Download failed") =>
  recordTrackJob(job, {
    status: "failed",
    statusLabel: "Failed",
    title: `Failed to download ${job?.trackName || "track"}`,
    subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
  });

export const recordTrackJobBlocked = (job, message = "Blocked for review") =>
  recordTrackJob(job, {
    status: "blocked",
    statusLabel: "Review",
    title: `Review needed for ${job?.trackName || "track"}`,
    subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
    sourceFilename: resolveBlockedJobSourceFilename(job),
  });

export const toHistoryRequestItem = (entry, options = {}) => {
  const kind = entry.kind || null;
  const source = resolveHistorySource(kind, entry.metadata);
  const sourceFilename =
    String(options.sourceFilename || entry.metadata?.sourceFilename || "").trim() || null;
  const trackName =
    String(options.trackName || entry.metadata?.trackName || "").trim() || null;
  const albumName =
    String(options.albumName || entry.metadata?.albumName || "").trim() || null;
  const requester = requesterFromMetadata(entry.metadata);
  return {
    id: entry.id,
    source,
    type: "activity",
    title: entry.title,
    subtitle: entry.subtitle || null,
    status: entry.status || "completed",
    statusLabel: entry.statusLabel || null,
    requestedAt: toIso(entry.createdAt),
    href: entry.href || null,
    kind,
    playlistId: entry.metadata?.playlistId || null,
    playlistName: entry.metadata?.playlistName || null,
    jobId: entry.metadata?.jobId || null,
    trackName,
    artistName: entry.metadata?.artistName || null,
    albumName,
    albumId: entry.metadata?.albumId ? String(entry.metadata.albumId) : null,
    requestedBy: requester
      ? { id: requester.userId, username: requester.username || null }
      : null,
    sourceFilename,
    inQueue:
      entry.status === "processing" ||
      entry.status === "pending" ||
      entry.status === "blocked",
    canReSearch:
      entry.kind === "album_requested" &&
      entry.status === "failed" &&
      Boolean(entry.metadata?.albumId),
  };
};

const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const buildActiveTrackHistory = (job) => {
  const playlistId = job?.playlistId || job?.playlistType;
  const status =
    job?.status === "blocked" ? "blocked" : job?.status === "downloading" ? "processing" : "pending";
  const statusLabel =
    status === "blocked" ? "Review" : status === "processing" ? "Downloading" : "Queued";
  const title =
    status === "blocked"
      ? `Review needed for ${job?.trackName || "track"}`
      : status === "processing"
        ? `Downloading ${job?.trackName || "track"} via ${resolveDownloadClientLabel(job?.downloadSource, job?.downloadClient)}`
        : `Queued ${job?.trackName || "track"}`;
  return {
    id: stableId("track_download", job?.id),
    kind: "track_download",
    title,
    subtitle: `${job?.artistName || "Artist"} · ${resolvePlaylistName(playlistId)}`,
    status,
    statusLabel,
    href: buildPlaylistHref(playlistId),
    metadata: {
      jobId: job?.id,
      trackName: job?.trackName,
      artistName: job?.artistName,
      ...(job?.albumName ? { albumName: job.albumName } : {}),
      playlistId,
      downloadSource: job?.downloadSource || "slskd",
      downloadClient: job?.downloadClient || null,
    },
    createdAt: Number(job?.createdAt) || Date.now(),
  };
};

export const getAurralHistoryRequests = async (lidarrClient = null, user = null) => {
  await syncActivityFeedHistory(lidarrClient);
  const entries = [...(await loadPendingPlaylistImportHistory(user)), ...loadRecentHistory()];
  const entryIds = new Set(entries.map((e) => e.id));

  const { downloadTracker } = await import("./weeklyFlow/weeklyFlowDownloadTracker.js");
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "blocked" && job.status !== "pending" && job.status !== "downloading") {
      continue;
    }
    const historyId = stableId("track_download", job.id);
    if (entryIds.has(historyId)) continue;
    const row = dbOps.getAurralHistoryById(historyId);
    const entry = row || buildActiveTrackHistory(job);
    if (!canViewPlaylistActivity(user, entry.metadata?.playlistId || entry.metadata?.playlistType)) {
      continue;
    }
    entries.push(entry);
    entryIds.add(historyId);
  }

  const now = Date.now();
  const jobsById = new Map(downloadTracker.getAll().map((job) => [job.id, job]));
  return entries
    .filter(
      (e) =>
        !ACTIVITY_HIDDEN_KINDS.has(e.kind) &&
        canViewPlaylistActivity(
          user,
          e.metadata?.playlistId || e.metadata?.playlistType,
          e.metadata?.ownerUserId,
        ) &&
        (e.status !== "failed" || now - e.createdAt < FAILED_RETENTION_MS),
    )
    .map((entry) => {
      const jobId = String(entry.metadata?.jobId || "").trim();
      const job = jobId ? jobsById.get(jobId) : null;
      const sourceFilename =
        entry.metadata?.sourceFilename ||
        (entry.status === "blocked" && job
          ? resolveBlockedJobSourceFilename(job)
          : null);
      const albumName =
        entry.metadata?.albumName ||
        (entry.status === "blocked" && job?.albumName ? job.albumName : null);
      const trackName =
        entry.metadata?.trackName ||
        (entry.status === "blocked" && job?.trackName ? job.trackName : null);
      if (
        entry.kind === "track_download" &&
        job?.status === "done" &&
        (entry.status === "pending" || entry.status === "processing")
      ) {
        entry.status = "completed";
        entry.statusLabel = entry.statusLabel === "Queued" ? "Reused" : "Downloaded";
      }
      return toHistoryRequestItem(entry, { sourceFilename, albumName, trackName });
    });
};
