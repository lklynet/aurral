import crypto from "crypto";
import { dbOps } from "../config/db-helpers.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KIND_SOURCE_MAP = {
  track_download: "slskd",
  album_requested: "lidarr",
  artist_added: "lidarr",
  track_reused_lidarr: "lidarr",
  track_reused_aurral: "aurral",
  discovery_refresh: "aurral",
  flow_generated: "aurral",
  flow_generating: "aurral",
  playlist_tracks_added: "aurral",
};

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

const createId = () =>
  `aurral-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

const stableId = (kind, referenceId) =>
  `aurral-${kind}-${String(referenceId || "").trim()}`;

const toIso = (createdAt) => {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) {
    return new Date().toISOString();
  }
  return new Date(value).toISOString();
};

const resolveHistorySource = (kind) => KIND_SOURCE_MAP[kind] || "aurral";

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
  const referenceId = entry.referenceId
    ? String(entry.referenceId).trim()
    : null;
  const kind = String(entry.kind || "activity").trim();
  const id = referenceId ? stableId(kind, referenceId) : createId();
  const existing = dbOps.getAurralHistoryById(id);
  const createdAt = existing?.createdAt || Number(entry.createdAt) || Date.now();
  const record = {
    id,
    kind,
    title,
    subtitle: entry.subtitle ? String(entry.subtitle).trim() : null,
    status: String(entry.status || "completed").trim(),
    statusLabel: entry.statusLabel ? String(entry.statusLabel).trim() : null,
    href: entry.href ? String(entry.href).trim() : null,
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : null,
    createdAt,
  };
  dbOps.insertAurralHistory(record);
  dbOps.pruneAurralHistory({ maxAgeMs: MAX_AGE_MS });
  return record;
};

export const recordAurralHistory = (entry = {}) => appendAurralHistory(entry);

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

export const recordDiscoveryUpdated = ({
  recommendationCount = 0,
  genreCount = 0,
} = {}) => {
  const parts = [];
  if (recommendationCount > 0) {
    parts.push(
      `${recommendationCount} recommendation${recommendationCount === 1 ? "" : "s"}`,
    );
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

export const recordAlbumRequested = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  searching = false,
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(albumId || artistMbid || name).trim();
  if (!ref) return null;
  return upsertAurralHistory({
    referenceId: ref,
    kind: "album_requested",
    title: searching ? `Searching Lidarr for ${name}` : `Requested ${name}`,
    subtitle: artist || null,
    status: searching ? "processing" : "completed",
    statusLabel: searching ? "Searching" : "Requested",
    href: buildArtistHref(artistMbid),
    metadata: { albumId, albumName: name, artistName: artist, artistMbid },
  });
};

export const recordAlbumSearchStarted = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
} = {}) =>
  recordAlbumRequested({
    albumId,
    albumName,
    artistName,
    artistMbid,
    searching: true,
  });

export const recordAlbumSearchFailed = ({
  albumId,
  albumName,
  artistName,
  artistMbid,
  statusLabel = "Not found",
} = {}) => {
  const name = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  const ref = String(albumId || artistMbid || name).trim();
  if (!ref) return null;
  return upsertAurralHistory({
    referenceId: ref,
    kind: "album_requested",
    title: `No results for ${name}`,
    subtitle: artist || null,
    status: "failed",
    statusLabel,
    href: buildArtistHref(artistMbid),
    metadata: { albumId, albumName: name, artistName: artist, artistMbid },
  });
};

export const syncAlbumSearchHistory = async (lidarrClient) => {
  if (!lidarrClient?.isConfigured()) return;

  const cutoff = Date.now() - MAX_AGE_MS;
  const pendingEntries = dbOps
    .getAurralHistory({ since: cutoff, limit: 300 })
    .filter(
      (entry) =>
        entry.kind === "album_requested" && entry.status === "processing",
    );
  if (!pendingEntries.length) return;

  const { parseLidarrSearchContext, resolveAlbumSearchOutcome } = await import(
    "./albumSearchState.js"
  );
  const [queue, history, commands] = await Promise.all([
    lidarrClient.getQueue().catch(() => []),
    lidarrClient.getHistory(1, 200).catch(() => ({ records: [] })),
    lidarrClient.request("/command").catch(() => []),
  ]);
  const context = parseLidarrSearchContext({ queue, history, commands });

  for (const entry of pendingEntries) {
    const albumId = entry.metadata?.albumId;
    if (!albumId) continue;
    const outcome = resolveAlbumSearchOutcome(albumId, context, {
      searchStartedAt: entry.createdAt,
    });
    if (!outcome || outcome.status !== "failed") continue;
    recordAlbumSearchFailed({
      albumId,
      albumName: entry.metadata?.albumName,
      artistName: entry.metadata?.artistName,
      artistMbid: entry.metadata?.artistMbid,
      statusLabel: outcome.statusLabel,
    });
  }
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

export const recordFlowTracksGenerated = ({
  flowId,
  tracksQueued = 0,
  reserveTracks = 0,
} = {}) => {
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
    total === 1
      ? `Added 1 track to ${playlistName}`
      : `Added ${total} tracks to ${playlistName}`;
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
    kind:
      sourceType === "lidarr" ? "track_reused_lidarr" : "track_reused_aurral",
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
  playlistId,
  status = "processing",
  statusLabel = "Searching",
  title = null,
  subtitle = null,
} = {}) => {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const playlistName = resolvePlaylistName(playlistId);
  const track = String(trackName || "Track").trim();
  const artist = String(artistName || "Artist").trim();
  return upsertAurralHistory({
    referenceId: id,
    kind: "track_download",
    title: title || `Searching slskd for ${track}`,
    subtitle: subtitle || `${artist} · ${playlistName}`,
    status,
    statusLabel,
    href: buildPlaylistHref(playlistId),
    metadata: { jobId: id, trackName: track, artistName: artist, playlistId },
  });
};

export const recordTrackJobSearching = (job) =>
  recordTrackJobActivity({
    jobId: job?.id,
    trackName: job?.trackName,
    artistName: job?.artistName,
    playlistId: job?.playlistId || job?.playlistType,
    status: "processing",
    statusLabel: "Searching",
    title: `Searching slskd for ${job?.trackName || "track"}`,
  });

export const recordTrackJobDownloading = (job) =>
  recordTrackJobActivity({
    jobId: job?.id,
    trackName: job?.trackName,
    artistName: job?.artistName,
    playlistId: job?.playlistId || job?.playlistType,
    status: "processing",
    statusLabel: "Downloading",
    title: `Downloading ${job?.trackName || "track"} via slskd`,
  });

export const recordTrackJobMoving = (job) =>
  recordTrackJobActivity({
    jobId: job?.id,
    trackName: job?.trackName,
    artistName: job?.artistName,
    playlistId: job?.playlistId || job?.playlistType,
    status: "processing",
    statusLabel: "Moving",
    title: `Moving ${job?.trackName || "track"} into playlist library`,
  });

export const recordTrackJobCompleted = (job) =>
  recordTrackJobActivity({
    jobId: job?.id,
    trackName: job?.trackName,
    artistName: job?.artistName,
    playlistId: job?.playlistId || job?.playlistType,
    status: "completed",
    statusLabel: "Downloaded",
    title: `Downloaded ${job?.trackName || "track"}`,
    subtitle: `${job?.artistName || "Artist"} · ${resolvePlaylistName(job?.playlistId || job?.playlistType)}`,
  });

export const recordTrackJobFailed = (job, message = "Download failed") =>
  recordTrackJobActivity({
    jobId: job?.id,
    trackName: job?.trackName,
    artistName: job?.artistName,
    playlistId: job?.playlistId || job?.playlistType,
    status: "failed",
    statusLabel: "Failed",
    title: `Failed to download ${job?.trackName || "track"}`,
    subtitle: String(message || "").trim() || `${job?.artistName || "Artist"}`,
  });

export const toHistoryRequestItem = (entry) => {
  const kind = entry.kind || null;
  const source = resolveHistorySource(kind);
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
    jobId: entry.metadata?.jobId || null,
    albumId: entry.metadata?.albumId ? String(entry.metadata.albumId) : null,
    inQueue: entry.status === "processing" || entry.status === "pending",
    canReSearch:
      entry.kind === "album_requested" &&
      entry.status === "failed" &&
      Boolean(entry.metadata?.albumId),
  };
};

export const getAurralHistoryRequests = async (lidarrClient = null) => {
  if (lidarrClient) {
    await syncAlbumSearchHistory(lidarrClient);
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  const entries = dbOps.getAurralHistory({ since: cutoff, limit: 300 });
  return entries.map(toHistoryRequestItem);
};
