import { asAppError } from "../../lib/errors.ts";
import crypto from "crypto";
import { dbOps } from "../db/helpers/index.ts";
import { resolveBlockedJobReleaseTitle, resolveBlockedJobSourceFilename } from "./downloadUtils.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import type {
  AurralHistoryEntry,
  AurralHistoryMetadata,
  TrackUpgrade,
} from "../db/helpers/history.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import type { DownloadJob, JobFields } from "./downloadJobs/downloadTracker.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { logger } from "./logger.ts";
import { albumPath } from "../../lib/albumPath.ts";

type HistoryRequester = { userId: number; username?: string };
export type RequesterUser = Pick<RequestUser, "id" | "username" | "role">;

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

export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const resolvePlaylistName = (playlistId: string | null | undefined) => {
  const id = String(playlistId || "").trim();
  if (!id) return "Playlist";
  const shared = flowPlaylistConfig.getStaticPlaylist(id);
  if (shared?.name) return shared.name;
  const flow = flowPlaylistConfig.getFlow(id);
  if (flow?.name) return flow.name;
  return id;
};

export const buildPlaylistHref = (playlistId: string | null | undefined) => {
  const id = String(playlistId || "").trim();
  if (!id) return "/playlists";
  return `/playlists?selected=${encodeURIComponent(id)}`;
};

export const buildTrackJobHref = (
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

export const reportRecordFailure = (error: unknown) => {
  logger.warn("history", "Could not record activity", {
    reason: asAppError(error)?.message || String(error),
  });
  return null;
};

const recorder =
  <Args extends unknown[], Result>(record: (...args: Args) => Result) =>
  (...args: Args) => {
    try {
      return record(...args);
    } catch (error) {
      return reportRecordFailure(error);
    }
  };

const createId = () => `aurral-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

export const stableId = (kind: string, referenceId: string | number | null | undefined) =>
  `aurral-${kind}-${String(referenceId || "").trim()}`;

export const resolveTrackDownloadHistorySource = (
  downloadSource: unknown,
  downloadClient: unknown,
) => {
  const normalized = String(downloadSource || "")
    .trim()
    .toLowerCase();
  if (normalized === "usenet") {
    const client = String(downloadClient || "")
      .trim()
      .toLowerCase();
    return client === "sabnzbd" || client === "tidarr" ? client : "nzbget";
  }
  if (normalized === "tidarr") return "tidarr";
  if (normalized === "ytdlp") return "ytdlp";
  if (normalized === "deemix") return "deemix";
  if (normalized === "slskd") return "slskd";
  if (normalized === "qbittorrent") return "qbittorrent";
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
  qbittorrent: "qBittorrent",
  share: "Aurral share",
};
const resolveDownloadClientLabel = (downloadSource: unknown, downloadClient: unknown) => {
  const source = resolveTrackDownloadHistorySource(downloadSource, downloadClient);
  return isOwnKey(CLIENT_LABELS, source) ? CLIENT_LABELS[source] : null;
};

export const downloadClientSuffix = (job: HistoryJob | null | undefined) => {
  const label = resolveDownloadClientLabel(job?.downloadSource, job?.downloadClient);
  return label ? ` via ${label}` : "";
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

export const recordDiscoveryRefreshStarted = recorder(() =>
  upsertAurralHistory({
    referenceId: "discovery",
    kind: "discovery_refresh",
    title: "Refreshing discovery",
    subtitle: "Gathering recommendations from your library and listening history",
    status: "processing",
    statusLabel: "Refreshing",
    href: "/",
  }),
);

export const recordDiscoveryUpdated = recorder(
  ({
    recommendationCount = 0,
    genreCount = 0,
  }: { recommendationCount?: number; genreCount?: number } = {}) => {
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
  },
);

export const recordDiscoveryRefreshFailed = recorder(
  (message: string = "Discovery refresh failed") =>
    upsertAurralHistory({
      referenceId: "discovery",
      kind: "discovery_refresh",
      title: "Discovery refresh failed",
      subtitle: String(message || "").trim() || null,
      status: "failed",
      statusLabel: "Failed",
      href: "/",
    }),
);

export const recordArtistAdded = recorder(
  ({ artistName, artistMbid }: { artistName?: string | null; artistMbid?: string | null } = {}) => {
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
  },
);

const requesterFromUser = (user: RequesterUser | null | undefined): HistoryRequester | null => {
  if (user?.id == null) return null;
  const username = String(user.username || "").trim();
  return { userId: user.id, ...(username && { username }) };
};

export const requesterFromMetadata = (
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
      console.warn(`[AurralHistory] ${notifyName} failed:`, asAppError(err)?.message || err);
    });
};

type AlbumRef = {
  albumId?: string | number | null;
  albumName?: string | null;
  artistName?: string | null;
  artistMbid?: string | null;
};

export const recordAlbumRequested = recorder(
  ({
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
  },
);

export const recordAlbumSearchStarted = recorder(
  ({
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
    }),
);

export const recordMissingTrackSearch = recorder(
  ({
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
  },
);

export const recordAlbumSearchFailed = recorder(
  ({
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
  },
);

export const recordAlbumSearchCompleted = recorder(
  ({
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
  },
);

export const albumRequestReferenceId = (entry: AurralHistoryEntry) => {
  const prefix = "aurral-album_requested-";
  if (typeof entry?.id === "string" && entry.id.startsWith(prefix)) {
    return entry.id.slice(prefix.length);
  }
  return String(entry?.metadata?.albumId || entry?.metadata?.artistMbid || "").trim();
};

export const recordAlbumImportCompleted = recorder(
  ({ albumId, albumName, artistName, artistMbid }: AlbumRef = {}) => {
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
  },
);

export const recordFlowGenerationStarted = recorder(
  ({ flowId }: { flowId?: string | null } = {}) => {
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
  },
);

export const recordFlowTracksGenerated = recorder(
  ({
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
  },
);

export const recordPlaylistTracksAdded = recorder(
  ({
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
  },
);

export const recordTrackReused = recorder(
  ({
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
  },
);

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

export const recordTrackJobActivity = recorder(
  ({
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
  },
);

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

export const recordTrackJobSearching = recorder((job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Searching",
  }),
);

export const getTrackJobRequesterId = (jobId: string) =>
  requesterFromMetadata(dbOps.getAurralHistoryById(stableId("track_download", jobId))?.metadata)
    ?.userId ?? null;

export const recordTrackJobQueued = recorder(
  (
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
  },
);

export const recordTrackJobDownloading = recorder((job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Downloading",
    title: `Downloading ${job?.trackName || "track"}${downloadClientSuffix(job)}`,
  }),
);

export const recordTrackJobWaiting = recorder(
  (job: HistoryJob | null | undefined, reason: string) =>
    recordTrackJob(job, {
      status: "processing",
      statusLabel: "Waiting",
      title: `Waiting to download ${job?.trackName || "track"}${downloadClientSuffix(job)}`,
      subtitle: reason,
    }),
);

export const recordTrackJobMoving = recorder((job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "processing",
    statusLabel: "Moving",
    title: `Moving ${job?.trackName || "track"} into playlist library`,
  }),
);

export const recordTrackJobCompleted = recorder(
  (job: HistoryJob | null | undefined, statusLabel: string = "Downloaded") =>
    recordTrackJob(job, {
      status: "completed",
      statusLabel,
      title: `${statusLabel === "Reused" ? "Reused" : "Downloaded"} ${job?.trackName || "track"}`,
      subtitle: `${job?.artistName || "Artist"} · ${resolvePlaylistName(job?.playlistId || job?.playlistType)}`,
    }),
);

export const recordTrackJobFailed = recorder(
  (job: HistoryJob | null | undefined, message: string = "Download failed") =>
    recordTrackJob(job, {
      status: "failed",
      statusLabel: "Failed",
      title: `Failed to download ${job?.trackName || "track"}`,
      subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
    }),
);

export const recordTrackJobCancelled = recorder((job: HistoryJob | null | undefined) =>
  recordTrackJob(job, {
    status: "cancelled",
    statusLabel: "Cancelled",
    title: `Cancelled ${job?.trackName || "track"}`,
  }),
);

export const recordTrackJobBlocked = recorder(
  (job: HistoryJob, message: string = "Blocked for review") =>
    recordTrackJob(job, {
      status: "blocked",
      statusLabel: "Review",
      title: `Review needed for ${job?.trackName || "track"}`,
      subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
      sourceFilename: resolveBlockedJobSourceFilename(job),
      releaseTitle: resolveBlockedJobReleaseTitle(job),
    }),
);
