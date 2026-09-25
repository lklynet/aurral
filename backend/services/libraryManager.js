import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { UUID_REGEX } from "../../lib/uuid.js";
import { dbOps, userOps } from "../db/helpers/index.js";
import { hasPermission } from "../middleware/auth.js";
import {
  iterateCanonicalArtistProjection,
  getCanonicalArtistProjection,
  getCanonicalLibraryForAlbumReferences,
  getCanonicalLibraryForArtistReferences,
  getCanonicalLibraryPage,
  getCanonicalTrack,
  invalidateCanonicalLibraryCache,
} from "./libraryQueryService.js";
import { selectCanonicalFile } from "./canonicalFileSelector.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  buildIdentityKey,
  clearCanonicalLidarrAlbum,
  clearCanonicalLidarrArtist,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  removeLibraryTrackIfNoAvailableMedia,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryTrack,
} from "./libraryMediaStore.js";
import {
  getLibraryManagementEntry,
  getManagedByMap,
  setLibraryManagement,
} from "./libraryManagementStore.js";
import { cancelDownloadWorkForJobs } from "./weeklyFlow/weeklyFlowDownloadCancellationService.js";
import { restoreDownloadJobCancellations } from "./weeklyFlow/weeklyFlowDownloadCancellation.js";
import { removePlaylistFileIfUnshared } from "./weeklyFlow/weeklyFlowFileReuse.js";
import {
  cancelAurralAlbumJobs,
  findAurralAlbumJobs,
  jobMatchesTrack,
  summarizeAurralAlbum,
} from "./aurralAlbumJobs.js";
import {
  getDownloadSourceNotConfiguredMessage,
  isAnyDownloadSourceConfigured,
} from "./downloadSourceService.js";
import {
  listAurralArtistReleases,
  resolveAurralMonitorMode,
  selectAurralReleases,
} from "./aurralMonitoring.js";
import { enqueueSystemTaskJob } from "./honkerDb.js";
const normalizeTypeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const getTypeName = (item) => {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.name === "string") return item.name;
  if (typeof item.value === "string") return item.value;
  if (typeof item.albumType?.name === "string")
    return item.albumType.name;
  return "";
};
import {
  musicbrainzRequest,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistIdentityByMbid,
  musicbrainzResolveArtistMbidByName,
} from "./apiClients/index.js";
import { mapWithConcurrency } from "./discovery/helpers.js";
import { logger } from "./logger.js";
import { runMonitoringRepairSequence } from "./libraryMonitoringRepair.js";
import {
  getAlbumByMbid as getMetadataAlbumByMbid,
  getArtistByMbid as getMetadataArtistByMbid,
} from "./providers/brainzmashProvider.js";
const LIDARR_RETRY_MS = 60000;
const ARTIST_LIST_CACHE_TTL_MS = 15 * 60 * 1000;
const FULL_LIST_FALLBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const TRACKS_CACHE_TTL_MS = 120000;
const TRACKS_CACHE_MAX = 300;

let lidarrClient = null;
let _cachedArtists = [];
let _lastLidarrFailureAt = 0;
let _lastFullArtistFetchAt = 0;
let _artistsCachedAt = 0;
let _artistsInflight = null;
const _tracksCache = new Map();
export function invalidateLidarrArtistCache() {
  _cachedArtists = [];
  _artistsCachedAt = 0;
  _lastLidarrFailureAt = 0;
  _tracksCache.clear();
}
const _artistMonitoringRepairs = new Map();
const _albumAddInflight = new Map();
const _artistMappingInflight = new Map();
const ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR =
  "Album already exists in Lidarr under a different artist";
const LIBRARY_MANAGERS = new Set(["aurral", "lidarr"]);

function normalizeLibraryManager(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return LIBRARY_MANAGERS.has(normalized) ? normalized : null;
}

function buildAlbumConflict(album, message = null) {
  const statistics = album?.statistics || {};
  const details = {
    managedBy: album?.managedBy || null,
    manager: album?.managedBy || null,
    currentManager: album?.managedBy || null,
    sources: Array.isArray(album?.sources) ? album.sources : [],
    canonicalId: album?.canonicalId || album?.id || null,
    providerId: album?.providerId || album?.foreignAlbumId || album?.mbid || null,
    availability: {
      available: Boolean(album?.available),
      trackCount: Number(statistics.trackCount || 0),
      availableTrackCount: Number(statistics.trackFileCount || 0),
      percentOfTracks: Number(statistics.percentOfTracks || 0),
      sizeOnDisk: Number(statistics.sizeOnDisk || 0),
    },
  };
  const owner = details.managedBy ? ` managed by ${details.managedBy}` : " already exists";
  return {
    error: message || `Album is${owner}`,
    statusCode: 409,
    code: "album_owner_conflict",
    ...details,
    conflict: details,
  };
}

function throwLibraryError(result) {
  if (!result?.error) return;
  const error = new Error(result.error);
  Object.assign(error, result);
  throw error;
}

function scheduleCanonicalLibraryReconciliation() {
  invalidateCanonicalLibraryCache();
  return scheduleLibraryScan({ includeLidarr: true });
}

function mapCanonicalAlbum(album, artist, tracks = []) {
  const albumTrackIds = Array.isArray(album.trackIds) ? album.trackIds : [];
  const albumTracks = tracks.filter((track) => albumTrackIds.includes(track.id));
  const files = albumTracks.map((track) =>
    selectCanonicalFile(track.files, album.id, album.managedBy),
  );
  const availableFiles = files.filter((file) => file?.available);
  const trackCount = albumTracks.length;
  return {
    id: String(album.id),
    canonicalId: String(album.id),
    providerId: album.metadata?.id ?? null,
    artistId: String(album.artistId),
    artistName: artist?.name || album.albumArtist || null,
    artistMbid: artist?.mbid || null,
    mbid: album.mbid || album.releaseGroupMbid || null,
    releaseGroupMbid: album.releaseGroupMbid || null,
    foreignAlbumId:
      album.metadata?.foreignAlbumId || album.mbid || album.releaseGroupMbid || album.identityKey,
    albumName: album.title,
    title: album.title,
    path: album.metadata?.path || null,
    addedAt: album.metadata?.added || null,
    releaseDate: album.releaseDate || null,
    monitored: album.metadata?.monitored === true,
    managedBy: album.managedBy || null,
    monitorMode: album.monitorMode || null,
    sources: album.sources,
    available: Boolean(album.available),
    statistics: {
      trackCount,
      trackFileCount: availableFiles.length,
      sizeOnDisk: availableFiles.reduce((total, file) => total + Number(file.size || 0), 0),
      percentOfTracks: trackCount > 0
        ? Math.round((availableFiles.length / trackCount) * 100)
        : 0,
    },
  };
}

function mapCanonicalTrack(track, album) {
  const file = selectCanonicalFile(track.files, album?.id, album?.managedBy);
  const relation = (track.albums || []).find((entry) => entry.albumId === album?.id);
  return {
    id: String(track.id),
    canonicalId: String(track.id),
    providerId: track.metadata?.id ?? null,
    albumId: album ? String(album.id) : null,
    artistId: album ? String(album.artistId) : null,
    mbid: track.mbid || null,
    foreignTrackId:
      track.metadata?.foreignRecordingId || track.metadata?.foreignTrackId || track.mbid || track.identityKey,
    trackName: track.title,
    title: track.title,
    trackNumber: relation?.trackNumber || 0,
    discNumber: relation?.discNumber || 1,
    path: file?.path || null,
    hasFile: Boolean(file?.available),
    available: Boolean(file?.available),
    source: file?.source || null,
    managedBy: album?.managedBy || null,
    monitorMode: album?.monitorMode || null,
    monitored: album?.metadata?.monitored === true,
    sources: track.sources,
    size: Number(file?.size || 0),
    quality:
      file?.quality?.audioFormat ||
      file?.quality?.quality?.name ||
      file?.quality?.format ||
      null,
    addedAt: track.metadata?.added || null,
  };
}

function canonicalArtistFallback(reference) {
  return getCanonicalArtistProjection({ reference })[0] || null;
}

function canonicalLibraryForArtist(reference) {
  return getCanonicalLibraryForArtistReferences({
    source: "all",
    availableOnly: false,
    references: [reference],
  });
}

function canonicalLibraryForAlbum(reference) {
  return getCanonicalLibraryForAlbumReferences({
    source: "all",
    availableOnly: false,
    references: [reference],
  });
}

function canonicalAlbumsForArtist(reference) {
  const library = canonicalLibraryForArtist(reference);
  const artistId = library.albums[0]?.artistId;
  const artist = library.artists.find((entry) => entry.id === artistId);
  return library.albums.map((album) => mapCanonicalAlbum(album, artist, library.tracks));
}

function canonicalAlbumForReference(reference) {
  const library = canonicalLibraryForAlbum(reference);
  const album = library.albums[0];
  if (!album) return null;
  const artist = library.artists.find((entry) => entry.id === album.artistId);
  return mapCanonicalAlbum(album, artist, library.tracks);
}

function canonicalTracksForAlbum(reference) {
  const library = canonicalLibraryForAlbum(reference);
  const album = library.albums[0];
  if (!album) return [];
  return library.tracks
    .filter((track) => track.albums.some((entry) => entry.albumId === album.id))
    .map((track) => mapCanonicalTrack(track, album));
}

function canonicalRecentArtists(limit) {
  const normalizedLimit = Math.max(0, Number(limit) || 0);
  return normalizedLimit === 0
    ? []
    : getCanonicalArtistProjection({ pageSize: normalizedLimit });
}

function cachedOrCanonicalRecentArtists(limit) {
  const normalizedLimit = Math.max(0, Number(limit) || 0);
  if (normalizedLimit === 0) return [];
  if (Array.isArray(_cachedArtists) && _cachedArtists.length > 0) {
    return _cachedArtists.slice(0, normalizedLimit);
  }
  return canonicalRecentArtists(normalizedLimit);
}

function isLidarrNotFoundError(error) {
  return error?.response?.status === 404 ||
    error?.status === 404 ||
    /\b404\b|not found in lidarr/i.test(String(error?.message || ""));
}

async function removeLibraryDownloadJobs(track) {
  const normalize = (value) => String(value || "").trim().toLocaleLowerCase();
  const trackMbid = normalize(track?.mbid);
  const artistName = normalize(track?.artistName);
  const trackName = normalize(track?.title);
  const jobs = downloadTracker.getAll();
  const removedJobIds = new Set();
  for (const job of jobs) {
    if (job.playlistType !== "library") continue;
    const jobTrackMbid = normalize(job.trackMbid);
    const matchesName = normalize(job.artistName) === artistName
      && normalize(job.trackName) === trackName;
    const matchesTrack = trackMbid && jobTrackMbid
      ? jobTrackMbid === trackMbid
      : matchesName;
    if (matchesTrack) {
      removedJobIds.add(job.id);
    }
  }
  const jobsToRemove = jobs.filter(
    (job) => removedJobIds.has(job.id) || removedJobIds.has(job.upgradeForJobId),
  );
  if (jobsToRemove.length === 0) return [];
  await cancelDownloadWorkForJobs(jobsToRemove);
  const committedPaths = new Set();
  for (const job of jobsToRemove) {
    const completedJob = downloadTracker.getJob(job.id);
    if (completedJob?.managedBy !== "lidarr" && completedJob?.finalPath) {
      committedPaths.add(completedJob.finalPath);
    }
    downloadTracker.removeJob(job.id);
  }
  return [...committedPaths];
}

function buildTrackFileIndex(trackFiles) {
  const index = new Map();
  if (!Array.isArray(trackFiles)) return index;
  for (const file of trackFiles) {
    const fileId = Number(file?.id);
    if (Number.isFinite(fileId)) {
      index.set(fileId, file);
    }
    const trackIds = Array.isArray(file?.trackIds) ? file.trackIds : [];
    for (const trackId of trackIds) {
      const normalizedTrackId = Number(trackId);
      if (Number.isFinite(normalizedTrackId)) {
        index.set(`track:${normalizedTrackId}`, file);
      }
    }
  }
  return index;
}

function enrichLidarrTrackWithFiles(track, trackFileById) {
  if (!track || typeof track !== "object") return track;
  if (track.path || track.trackFile?.path) return track;

  const fileId = Number(track.trackFileId);
  if (Number.isFinite(fileId) && trackFileById.has(fileId)) {
    return { ...track, trackFile: trackFileById.get(fileId) };
  }

  const trackId = Number(track.id);
  if (Number.isFinite(trackId) && trackFileById.has(`track:${trackId}`)) {
    return { ...track, trackFile: trackFileById.get(`track:${trackId}`) };
  }

  return track;
}

function albumNeedsTrackFiles({ albumSizeOnDisk, isAlbumComplete, tracks }) {
  if (albumSizeOnDisk > 0 || isAlbumComplete) return true;
  if (!Array.isArray(tracks)) return false;
  return tracks.some(
    (track) => track?.hasFile === true || Number.isFinite(Number(track?.trackFileId)),
  );
}

function findCachedArtistByMbid(mbid) {
  if (!mbid || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return null;
  }
  return (
    _cachedArtists.find((artist) => artist?.mbid === mbid || artist?.foreignArtistId === mbid) ||
    null
  );
}

function findCachedArtistById(id) {
  const value = String(id ?? "").trim();
  if (!value || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return null;
  }
  return _cachedArtists.find((artist) =>
    [artist?.id, artist?.canonicalId, artist?.providerId].some(
      (candidate) => String(candidate ?? "").trim() === value,
    ),
  ) || null;
}

function upsertCachedArtist(mappedArtist) {
  if (!mappedArtist) return;
  const mbid = mappedArtist.mbid || mappedArtist.foreignArtistId;
  if (!mbid) return;
  const existingIndex = _cachedArtists.findIndex(
    (artist) => artist?.mbid === mbid || artist?.foreignArtistId === mbid,
  );
  if (existingIndex >= 0) {
    _cachedArtists[existingIndex] = mappedArtist;
    return;
  }
  _cachedArtists.unshift(mappedArtist);
}

function removeCachedArtistByMbid(mbid) {
  if (!mbid || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return;
  }
  _cachedArtists = _cachedArtists.filter(
    (artist) => artist?.mbid !== mbid && artist?.foreignArtistId !== mbid,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLidarrClient() {
  if (!lidarrClient) {
    try {
      const mod = await import("./lidarrClient.js");
      lidarrClient = mod.lidarrClient;
    } catch (err) {}
  }
  return lidarrClient;
}

function scheduleLidarrRetry() {
  import("./honkerDb.js")
    .then(({ enqueueSystemTaskJob, findActiveHonkerJob }) => {
      const existing = findActiveHonkerJob(
        "system-task",
        (payload) => payload?.kind === "lidarr-retry",
        { recoverExpired: true, payloadKind: "lidarr-retry" },
      );
      if (existing?.state === "pending") return;
      enqueueSystemTaskJob({ kind: "lidarr-retry" }, { delaySeconds: 60 });
    })
    .catch((err) => { logger.warn('library', err); });
}

export function getCachedArtistCount() {
  return getCachedArtists().length;
}

export function getCachedArtists() {
  const canonical = getCanonicalArtistProjection({ pageSize: 10000 });
  return canonical.length > 0 ? canonical : (Array.isArray(_cachedArtists) ? _cachedArtists : []);
}

function getSettings() {
  return dbOps.getSettings();
}

function normalizeReleaseTypeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getMetadataProfileTypeName(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.name === "string") return item.name;
  if (typeof item.value === "string") return item.value;
  if (typeof item.albumType?.name === "string") return item.albumType.name;
  return "";
}

export function buildPlaybackQueueFromCanonicalLibrary({ artists = [], albums = [], tracks = [] } = {}) {
  const artistsById = new Map(artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  const queue = [];

  for (const album of albums) {
    const artist = artistsById.get(album.artistId);
    for (const trackId of album.trackIds || []) {
      const track = tracksById.get(trackId);
      if (!track) continue;
      const file = selectCanonicalFile(track.files, album.id, album.managedBy);
      if (!file?.available) continue;
      const relation = (track.albums || []).find((entry) => entry.albumId === album.id);
      queue.push({
        id: `lib-${album.artistId}-${album.id}-${track.id}`,
        title: track.title || "Unknown Track",
        artist: artist?.name || track.artistName || "Unknown Artist",
        album: album.title || "Unknown Album",
        streamPath: `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
        streamFormat: file.format || null,
        quality: file.quality?.quality?.name || file.quality?.audioFormat || null,
        trackNumber: relation?.trackNumber || 0,
      });
    }
  }

  return queue.sort((left, right) =>
    left.artist.localeCompare(right.artist) ||
    left.album.localeCompare(right.album) ||
    left.trackNumber - right.trackNumber,
  );
}

export { buildTrackFileIndex, enrichLidarrTrackWithFiles, albumNeedsTrackFiles };

export class LibraryManager {
  async resolveManagedBy(requested, user = null) {
    const explicit = String(requested || "").trim().toLowerCase();
    if (explicit) {
      if (!LIBRARY_MANAGERS.has(explicit)) {
        const error = new Error("managedBy must be 'aurral' or 'lidarr'");
        error.statusCode = 400;
        error.code = "invalid_library_manager";
        throw error;
      }
      return explicit;
    }

    const preferred = normalizeLibraryManager(user?.defaultLibraryOwner);
    const lidarr = await getLidarrClient();
    if (preferred === "aurral") return "aurral";
    if (preferred === "lidarr" && lidarr?.isConfigured()) return "lidarr";
    return lidarr?.isConfigured() ? "lidarr" : "aurral";
  }

  async _addAurralArtist(mbid, artistName, options = {}) {
    const normalizedMbid = String(mbid || "").trim();
    const requestedName = String(artistName || "").trim();
    if (!normalizedMbid || !requestedName) {
      return { error: "artist MBID and name are required", statusCode: 400 };
    }

    const existing = canonicalArtistFallback(normalizedMbid);
    const resolvedMode = resolveAurralMonitorMode(options.monitorOption);
    if (resolvedMode.error) return resolvedMode;
    const monitorMode = resolvedMode.mode;
    if (existing) {
      if (!existing.managedBy) {
        setLibraryManagement({
          entityKind: "artist",
          entityId: existing.id,
          managedBy: "aurral",
          monitorMode,
        });
      }
      return canonicalArtistFallback(existing.id) || existing;
    }

    let metadata = null;
    try {
      metadata = await getMetadataArtistByMbid(normalizedMbid);
    } catch (error) {
      logger.warn("library", "Aurral artist metadata lookup failed", {
        mbid: normalizedMbid,
        message: error?.message || String(error),
      });
    }
    if (metadata?.id && String(metadata.id).trim().toLowerCase() !== normalizedMbid.toLowerCase()) {
      return {
        error: "Artist metadata does not unambiguously identify the requested artist",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }
    const name = String(metadata?.name || requestedName).trim();
    if (!name) {
      const error = new Error("Could not resolve an unambiguous artist identity");
      error.statusCode = 422;
      error.code = "ambiguous_identity";
      return { error: error.message, statusCode: error.statusCode, code: error.code };
    }

    const artist = upsertLibraryArtist({
      identityKey: buildIdentityKey("mbid", normalizedMbid),
      mbid: normalizedMbid,
      name,
      sortName: metadata?.sortName || name,
      metadata: {
        ...(metadata || {}),
        id: normalizedMbid,
        foreignArtistId: normalizedMbid,
        librarySource: "aurral",
        added: new Date().toISOString(),
        monitored: monitorMode !== "none",
        monitor: monitorMode,
        monitorOption: monitorMode,
        addOptions: { monitor: monitorMode },
      },
    });
    setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      managedBy: "aurral",
      monitorMode,
    });
    return canonicalArtistFallback(artist.id) || artist;
  }

  async addArtist(mbid, artistName, options = {}) {
    let managedBy;
    try {
      managedBy = await this.resolveManagedBy(options.managedBy, options.user);
    } catch (error) {
      return {
        error: error.message,
        statusCode: error.statusCode || 400,
        code: error.code || null,
      };
    }
    if (managedBy === "aurral") {
      return this._addAurralArtist(mbid, artistName, {
        ...options,
        managedBy,
      });
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    const isArtistAlreadyAddedError = (error) => {
      const message = String(error?.message || "").toLowerCase();
      return message.includes("artistexistsvalidator") ||
        message.includes("already been added") ||
        message.includes("constraint failed");
    };
    try {
      const lidarrSettings = getSettings();
      const lidarrArtist = await lidarr.addArtist(mbid, artistName, {
        albumOnly: options.albumOnly === true,
        albumMbid: options.albumMbid,
        triggerSearch: options.triggerSearch === true,
        monitorOption: options.monitorOption || "none",
        rootFolderPath: options.rootFolderPath,
        savedRootFolderPath: options.savedRootFolderPath,
        qualityProfileId: options.qualityProfileId,
        savedQualityProfileId: options.savedQualityProfileId,
        tagId: options.tagId,
        metadataProfileId:
          options.metadataProfileId || lidarrSettings.integrations?.lidarr?.metadataProfileId,
      });
      logger.info('library', `[LibraryManager] Added artist "${artistName}" to Lidarr`);
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
      scheduleCanonicalLibraryReconciliation();
      import("./aurralHistoryService.js")
        .then(({ recordArtistAdded }) =>
          recordArtistAdded({
            artistName: mappedArtist.artistName || artistName,
            artistMbid: mappedArtist.mbid || mbid,
          }),
        )
        .catch((err) => { logger.warn('library', err); });
      return mappedArtist;
    } catch (error) {
      if (isArtistAlreadyAddedError(error)) {
        try {
          const existing = await this.getArtist(mbid, { forceRefresh: true });
          if (existing) {
            return existing;
          }
        } catch {}
      }
      logger.error('library', `[LibraryManager] Failed to add artist to Lidarr: ${error.message}`);      return { error: error.message };
    }
  }

  async resolveArtistAddOptions(options = {}) {
    const managedBy = await this.resolveManagedBy(options.managedBy, options.user);
    const settings = getSettings();
    if (managedBy === "aurral") {
      return {
        managedBy,
        quality: options.quality || settings.quality || "standard",
        monitorOption: options.monitorOption || "none",
        albumOnly: options.albumOnly === true,
        albumMbid: options.albumMbid || null,
        rootFolderPath: null,
        qualityProfileId: null,
        tagId: options.tagId ?? null,
      };
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }

    const defaultMonitorOption = settings.integrations?.lidarr?.defaultMonitorOption || "none";
    const requestedMonitorOption =
      options.albumOnly === true
        ? "none"
        : options.monitorOption && options.monitorOption !== "none"
          ? options.monitorOption
          : defaultMonitorOption;
    const currentUser = options.user?.id != null ? userOps.getUserById(options.user.id) : null;
    const preparedAddOptions = await lidarr.resolveArtistAddConfiguration({
      requestRootFolderPath: options.rootFolderPath,
      requestQualityProfileId: options.qualityProfileId,
      savedRootFolderPath: currentUser?.lidarrRootFolderPath,
      savedQualityProfileId: currentUser?.lidarrQualityProfileId,
      settings,
    });

    return {
      managedBy,
      quality: options.quality || settings.quality || "standard",
      monitorOption: requestedMonitorOption,
      albumOnly: options.albumOnly === true,
      albumMbid: options.albumMbid || null,
      rootFolderPath: preparedAddOptions?.resolved?.rootFolderPath || null,
      qualityProfileId: preparedAddOptions?.resolved?.qualityProfileId ?? null,
      tagId: options.tagId ?? null,
      preparedAddOptions,
    };
  }

  async waitForAlbumByMbidForArtist(
    albumMbid,
    artistId,
    { delaysMs = [500, 1000, 2000, 4000, 8000, 8000] } = {},
  ) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }

    const normalizedAlbumMbid = String(albumMbid || "").trim();
    const normalizedAlbumMbidKey = normalizedAlbumMbid.toLowerCase();
    const normalizedArtistId = String(artistId || "").trim();
    if (!normalizedAlbumMbid || !normalizedArtistId) {
      return null;
    }

    const findAlbum = async () => {
      try {
        const album = await lidarr.getAlbumByMbid(normalizedAlbumMbid, {
          forceRefresh: true,
        });
        if (album && String(album.artistId) === normalizedArtistId) {
          return album;
        }
      } catch {}

      try {
        const albums = await lidarr.request(
          `/album?artistId=${encodeURIComponent(normalizedArtistId)}`,
          "GET",
          null,
          false,
          { forceRefresh: true },
        );
        const list = Array.isArray(albums)
          ? albums
          : Array.isArray(albums?.records)
            ? albums.records
            : [];
        return (
          list.find(
            (album) =>
              String(album?.foreignAlbumId ?? "")
                .trim()
                .toLowerCase() === normalizedAlbumMbidKey &&
              String(album?.artistId) === normalizedArtistId,
          ) || null
        );
      } catch {
        return null;
      }
    };

    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      const album = await findAlbum();
      if (album) return album;

      if (attempt < delaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }

    return null;
  }

  async applyArtistMonitoringDefaults(artist, albums = null) {
    if (!artist?.monitored || !artist?.monitorOption || artist.monitorOption === "none") {
      return;
    }
    if (artist.managedBy === "aurral") return;

    const lidarr = await getLidarrClient();
    let eligibleAlbums = Array.isArray(albums)
      ? albums
      : await this.getAlbums(artist.id, null, { forceRefresh: true });

    if (lidarr && lidarr.isConfigured() && artist?.id) {
      try {
        const lidarrArtist = await lidarr.getArtist(artist.id);
        const settings = getSettings();
        const fallbackMetadataProfileId = settings.integrations?.lidarr?.metadataProfileId;
        const metadataProfileId =
          lidarrArtist?.metadataProfileId ||
          lidarrArtist?.metadataProfile?.id ||
          fallbackMetadataProfileId;
        const profiles = metadataProfileId ? await lidarr.getMetadataProfiles() : null;
        const metadataProfile = Array.isArray(profiles)
          ? profiles.find((profile) => String(profile?.id) === String(metadataProfileId))
          : null;

        let allowedPrimaryTypes = null;
        if (metadataProfile?.primaryAlbumTypes) {
          const allowed = new Set();
          for (const item of metadataProfile.primaryAlbumTypes) {
            const name = getMetadataProfileTypeName(item);
            if (!name) continue;
            const isAllowed = typeof item === "string" ? true : item.allowed !== false;
            if (!isAllowed) continue;
            allowed.add(normalizeReleaseTypeName(name));
          }
          if (allowed.size > 0) {
            allowedPrimaryTypes = allowed;
          }
        }

        if (allowedPrimaryTypes) {
          const mbid = artist.mbid || artist.foreignArtistId || artist.id?.toString?.();
          const releaseGroups = mbid ? await musicbrainzGetArtistReleaseGroups(mbid) : [];
          const mbidToType = new Map(
            releaseGroups.map((rg) => [rg.id, normalizeReleaseTypeName(rg["primary-type"])]),
          );
          eligibleAlbums = eligibleAlbums.filter((album) => {
            const key = album.mbid || album.foreignAlbumId || album.id?.toString?.();
            const type = mbidToType.get(key);
            if (!type) return true;
            return allowedPrimaryTypes.has(type);
          });
        }
      } catch {}
    }

    const albumsToMonitor = [];
    const sortedAlbums = [...eligibleAlbums].sort((a, b) => {
      const dateA = a.releaseDate || a.addedAt || "";
      const dateB = b.releaseDate || b.addedAt || "";
      return dateB.localeCompare(dateA);
    });

    switch (artist.monitorOption) {
      case "existing":
      case "all":
        albumsToMonitor.push(...eligibleAlbums.filter((album) => !album.monitored));
        break;
      case "latest":
        if (sortedAlbums.length > 0 && !sortedAlbums[0].monitored) {
          albumsToMonitor.push(sortedAlbums[0]);
        }
        break;
      case "first": {
        const oldestAlbum = sortedAlbums[sortedAlbums.length - 1];
        if (oldestAlbum && !oldestAlbum.monitored) {
          albumsToMonitor.push(oldestAlbum);
        }
        break;
      }
      case "missing":
        albumsToMonitor.push(
          ...eligibleAlbums.filter((album) => {
            const stats = album.statistics || {};
            return !album.monitored && (stats.percentOfTracks || 0) < 100;
          }),
        );
        break;
      case "future": {
        const artistAddedDate = new Date(artist.addedAt);
        albumsToMonitor.push(
          ...eligibleAlbums.filter((album) => {
            if (album.monitored) return false;
            if (!album.releaseDate) return false;
            const releaseDate = new Date(album.releaseDate);
            return releaseDate > artistAddedDate;
          }),
        );
        break;
      }
    }

    if (lidarr && lidarr.isConfigured()) {
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      await Promise.allSettled(
        albumsToMonitor.map(async (album) => {
          try {
            await this.updateAlbum(album.id, { monitored: true });
            if (searchOnAdd) {
              await lidarr.request("/command", "POST", {
                name: "AlbumSearch",
                albumIds: [parseInt(album.id, 10)],
              });
            }
          } catch (err) {
            logger.error('library', `Failed to monitor/search album ${album.albumName}: ${err.message}`);          }
        }),
      );
    }
  }

  async addArtistWithResolvedOptions(mbid, artistName, options = {}) {
    const albumOnly = options.albumOnly === true;
    const requestedMonitorOption = options.monitorOption || "none";
    const artist = await this.addArtist(mbid, artistName, {
      managedBy: options.managedBy,
      user: options.user,
      quality: options.quality,
      albumOnly,
      albumMbid: options.albumMbid,
      triggerSearch: options.triggerSearch === true,
      monitorOption: requestedMonitorOption,
      rootFolderPath: options.rootFolderPath,
      qualityProfileId: options.qualityProfileId,
      tagId: options.tagId,
    });
    if (artist?.error) {
      return artist;
    }
    if (options.managedBy === "aurral" && !albumOnly && requestedMonitorOption !== "none") {
      const monitoring = await this.startAurralArtistMonitoring(artist, requestedMonitorOption);
      return { ...artist, monitoring };
    }
    if (options.managedBy !== "aurral" && !albumOnly && requestedMonitorOption !== "none") {
      const albums = await this.getAlbums(artist.id, null, {
        forceRefresh: true,
        managedBy: options.managedBy,
      });
      if (albums.length > 0) {
        await this.applyArtistMonitoringDefaults(artist, albums);
      } else {
        this.scheduleArtistMonitoringDefaults(artist);
      }
    }
    return artist;
  }

  scheduleArtistMonitoringDefaults(artist) {
    const artistId = String(artist?.id || "").trim();
    if (!artistId || _artistMonitoringRepairs.has(artistId)) return;

    const repair = (async () => {
      const delaysMs = [500, 1000, 2000, 4000, 8000, 8000];
      for (const delayMs of delaysMs) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, delayMs);
          timeout.unref?.();
        });
        const albums = await this.getAlbums(artistId, null, { forceRefresh: true });
        if (!albums.length) continue;
        if (artist.managedBy === "aurral") return;
        await this.applyArtistMonitoringDefaults(artist, albums);
        return;
      }
    })()
      .catch((error) => {
        logger.warn("library", "Failed to stabilize artist monitoring defaults", {
          artistId,
          message: error.message,
        });
      })
      .finally(() => {
        _artistMonitoringRepairs.delete(artistId);
      });

    _artistMonitoringRepairs.set(artistId, repair);
  }

  async addArtistWithPreferences(mbid, artistName, options = {}) {
    const resolvedOptions = await this.resolveArtistAddOptions(options);
    if (resolvedOptions?.error) {
      return resolvedOptions;
    }
    return this.addArtistWithResolvedOptions(mbid, artistName, {
      ...resolvedOptions,
      user: options.user,
      albumOnly: options.albumOnly === true,
      albumMbid: options.albumMbid || resolvedOptions.albumMbid || null,
      triggerSearch: options.triggerSearch === true,
    });
  }

  async fetchArtistAlbums(artistId, mbid) {
    try {
      const lidarr = await getLidarrClient();
      let allowedPrimaryTypes = null;
      if (lidarr && lidarr.isConfigured()) {
        try {
          const lidarrArtist = await lidarr.getArtist(artistId);
          const settings = getSettings();
          const fallbackMetadataProfileId = settings.integrations?.lidarr?.metadataProfileId;
          const metadataProfileId =
            lidarrArtist?.metadataProfileId ||
            lidarrArtist?.metadataProfile?.id ||
            fallbackMetadataProfileId;
          if (metadataProfileId) {
            const profiles = await lidarr.getMetadataProfiles();
            const profile = Array.isArray(profiles)
              ? profiles.find((item) => String(item?.id) === String(metadataProfileId))
              : null;
            if (profile?.primaryAlbumTypes) {
              const allowed = new Set();
              for (const item of profile.primaryAlbumTypes) {
                const name = getTypeName(item);
                if (!name) continue;
                const isAllowed = typeof item === "string" ? true : item.allowed !== false;
                if (!isAllowed) continue;
                allowed.add(normalizeTypeName(name));
              }
              if (allowed.size > 0) {
                allowedPrimaryTypes = allowed;
              }
            }
          }
        } catch {}
      }

      let releaseGroups = await musicbrainzGetArtistReleaseGroups(mbid);
      if (allowedPrimaryTypes) {
        releaseGroups = releaseGroups.filter((rg) =>
          allowedPrimaryTypes.has(normalizeTypeName(rg["primary-type"])),
        );
      }
      const limitedReleaseGroups = releaseGroups.slice(0, 50);

      for (const rg of limitedReleaseGroups) {
        const result = await this.addAlbum(artistId, rg.id, rg.title, {
          releaseDate: rg["first-release-date"] || null,
          triggerSearch: false,
        });
        if (result?.error) {
          logger.error('library', `Failed to add album ${rg.title}: ${result.error}`);
        }
      }
    } catch (error) {
      logger.error('library', `Failed to fetch albums for artist ${mbid}: ${error.message}`);    }
  }

  async fetchAlbumTracks(albumId, releaseGroupMbid) {
    try {
      const rgData = await musicbrainzRequest(`/release-group/${releaseGroupMbid}`, {
        inc: "releases",
      });

      if (rgData.releases && rgData.releases.length > 0) {
        const releaseId = rgData.releases[0].id;

        const releaseData = await musicbrainzRequest(`/release/${releaseId}`, {
          inc: "recordings",
        });

        if (releaseData.media && releaseData.media.length > 0) {
          for (const medium of releaseData.media) {
            if (medium.tracks) {
              for (const track of medium.tracks) {
                const recording = track.recording;
                if (recording) {
                  try {
                    await this.addTrack(
                      albumId,
                      recording.id,
                      recording.title,
                      track.position || 0,
                    );
                  } catch (err) {
                    if (!err.message.includes("already exists")) {
                      logger.error('library', `Failed to add track ${recording.title}: ${err.message}`);                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error('library', `Failed to fetch tracks for album ${releaseGroupMbid}: ${error.message}`);    }
  }

  async getArtist(mbid, { forceRefresh = false, managedBy = null } = {}) {
    const canonical = canonicalArtistFallback(mbid);
    if (normalizeLibraryManager(managedBy) === "aurral" ||
      (managedBy == null && canonical?.managedBy === "aurral")) return canonical;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return canonical;
    if (!forceRefresh) {
      const cachedArtist = findCachedArtistByMbid(mbid);
      if (cachedArtist) {
        return cachedArtist;
      }
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid, { forceRefresh });
      if (!lidarrArtist) return managedBy == null ? canonical : null;
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
      return mappedArtist;
    } catch (error) {
      if (!isLidarrNotFoundError(error)) {
        return findCachedArtistByMbid(mbid) || canonicalArtistFallback(mbid);
      }
      return managedBy == null ? canonical : null;
    }
  }

  async getArtistById(id, { managedBy = null } = {}) {
    const canonical = canonicalArtistFallback(id);
    if (normalizeLibraryManager(managedBy) === "aurral" ||
      (managedBy == null && canonical?.managedBy === "aurral")) return canonical;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return canonical;
    try {
      const lidarrArtist = await lidarr.getArtist(id);
      await this.backfillLidarrArtistMappings([lidarrArtist]);
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      if (!isLidarrNotFoundError(error)) return findCachedArtistById(id) || canonical;
      return managedBy == null ? canonical : null;
    }
  }

  async ensureArtistMonitored(artist, monitorOption = null) {
    if (!artist || artist.monitored !== false) {
      return artist;
    }

    const mbid = artist.mbid || artist.foreignArtistId;
    if (!mbid) {
      return artist;
    }

    const nextMonitorOption =
      monitorOption || artist.monitorOption || artist.addOptions?.monitor || "none";
    const updated = await this.updateArtist(mbid, {
      monitored: true,
      monitorOption: nextMonitorOption,
    });
    return updated?.error ? artist : updated;
  }

  async ensureRequestedAlbumMonitoring(artistId, albumId, options = {}) {
    const normalizedArtistId = String(artistId || "").trim();
    const normalizedAlbumId = String(albumId || "").trim();
    if (!normalizedArtistId || !normalizedAlbumId) {
      return { artist: null, album: null };
    }

    let artist = await this.getArtistById(normalizedArtistId);
    if (artist?.monitored === false) {
      artist = await this.ensureArtistMonitored(artist, options.monitorOption);
    }

    let album = await this.getAlbumById(normalizedAlbumId);
    if (album?.monitored === false) {
      album = await this.updateAlbum(normalizedAlbumId, { monitored: true });
    }

    return { artist, album };
  }

  scheduleRequestedAlbumMonitoringRepair(artistId, albumId, options = {}) {
    const normalizedArtistId = String(artistId || "").trim();
    const normalizedAlbumId = String(albumId || "").trim();
    if (!normalizedArtistId || !normalizedAlbumId) return;

    runMonitoringRepairSequence({
      // These increments preserve the previous 1s/3s/8s/15s checkpoints.
      delaysMs: [1000, 2000, 5000, 7000],
      repair: () =>
        this.ensureRequestedAlbumMonitoring(
          normalizedArtistId,
          normalizedAlbumId,
          options,
        ),
    })
      .then(({ complete, error }) => {
        if (!complete && error) {
          logger.error(
            "library",
            `[LibraryManager] Failed to stabilize requested album monitoring: ${error.message}`,
          );
        }
      })
      .catch((error) => {
        logger.error(
          "library",
          `[LibraryManager] Failed to stabilize requested album monitoring: ${error.message}`,
        );
      });
  }

  async getAllArtists() {
    return [...iterateCanonicalArtistProjection({ pageSize: 100 })];
  }

  async syncLidarrArtists({ forceRefresh = false } = {}) {
    if (
      forceRefresh !== true &&
      _cachedArtists.length > 0 &&
      Date.now() - _artistsCachedAt < ARTIST_LIST_CACHE_TTL_MS
    ) {
      return _cachedArtists;
    }
    if (_artistsInflight) return _artistsInflight;

    _artistsInflight = (async () => {
      try {
        const lidarr = await getLidarrClient();
        if (!lidarr || !lidarr.isConfigured()) {
          return _cachedArtists;
        }
        if (
          forceRefresh !== true &&
          _lastLidarrFailureAt &&
          Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS
        ) {
          return _cachedArtists;
        }
        try {
          const lidarrArtists = await lidarr.request(
            "/artist",
            "GET",
            null,
            false,
            { forceRefresh: forceRefresh === true },
          );
          _lastLidarrFailureAt = 0;
          if (!Array.isArray(lidarrArtists)) {
            return _cachedArtists;
          }
          await this.backfillLidarrArtistMappings(lidarrArtists);
          _cachedArtists = lidarrArtists.map((a) => this.mapLidarrArtist(a));
          _artistsCachedAt = Date.now();
          scheduleCanonicalLibraryReconciliation();
          import("../../services/unifiedSearchService.js").then(({ clearSearchContextCache }) => clearSearchContextCache()).catch(() => {});
          return _cachedArtists;
        } catch (error) {
          const wasHealthy = _lastLidarrFailureAt === 0;
          _lastLidarrFailureAt = Date.now();
          scheduleLidarrRetry();
          if (wasHealthy) {
            const msg = (error && error.message) || String(error);
            logger.warn('library', `[LibraryManager] Lidarr unavailable: ${msg} - using cached artists (if any). Retrying every 60s.`);
          }
          return _cachedArtists;
        }
      } catch (_) {
        return _cachedArtists;
      }
    })().finally(() => {
      _artistsInflight = null;
    });
    return _artistsInflight;
  }

  async getRecentArtists(limit = 25, poolSize = 100) {
    try {
      const lidarr = await getLidarrClient();
      if (!lidarr || !lidarr.isConfigured()) {
        return canonicalRecentArtists(limit);
      }
      if (_lastLidarrFailureAt && Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS) {
        return cachedOrCanonicalRecentArtists(limit);
      }
      const normalizedLimit = Math.max(0, limit);
      const normalizedPool = Math.max(normalizedLimit, poolSize);
      const pageSize = Math.max(normalizedPool * 2, normalizedPool);
      const history = await lidarr.getHistory(1, pageSize, "date", "descending");
      const records = Array.isArray(history) ? history : history?.records || [];
      const artistIds = [];
      const seen = new Set();
      for (const record of records) {
        const id = record?.artistId ?? record?.artist?.id;
        if (id === undefined || id === null) continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        artistIds.push(key);
        if (artistIds.length >= normalizedPool) break;
      }
      if (artistIds.length === 0) {
        if (
          (!Array.isArray(_cachedArtists) || _cachedArtists.length === 0) &&
          Date.now() - _lastFullArtistFetchAt > FULL_LIST_FALLBACK_COOLDOWN_MS
        ) {
          try {
            const lidarrArtists = await lidarr.request("/artist");
            if (Array.isArray(lidarrArtists)) {
              await this.backfillLidarrArtistMappings(lidarrArtists);
              _cachedArtists = lidarrArtists.map((a) => this.mapLidarrArtist(a));
              _lastFullArtistFetchAt = Date.now();
            }
          } catch {}
        }
        return cachedOrCanonicalRecentArtists(normalizedLimit);
      }
      const picked = artistIds.sort(() => 0.5 - Math.random()).slice(0, normalizedLimit);
      const artists = await Promise.all(picked.map((id) => lidarr.getArtist(id).catch(() => null)));
      await this.backfillLidarrArtistMappings(artists.filter(Boolean));
      const mapped = artists.filter(Boolean).map((artist) => this.mapLidarrArtist(artist));
      if (mapped.length >= normalizedLimit) return mapped;
      if (Array.isArray(_cachedArtists) && _cachedArtists.length > 0) {
        const existing = new Set(
          mapped.map((artist) => artist.mbid || artist.foreignArtistId || artist.id),
        );
        const fallback = _cachedArtists.filter(
          (artist) => !existing.has(artist.mbid || artist.foreignArtistId || artist.id),
        );
        const extra = fallback
          .sort(() => 0.5 - Math.random())
          .slice(0, Math.max(0, normalizedLimit - mapped.length));
        return [...mapped, ...extra];
      }
      return mapped.length > 0 ? mapped : canonicalRecentArtists(normalizedLimit);
    } catch (_) {
      return cachedOrCanonicalRecentArtists(limit);
    }
  }

  mapLidarrArtist(lidarrArtist) {
    const artistPath = lidarrArtist.path ?? null;
    const artistId = Number(lidarrArtist.id);
    const foreignArtistId = String(lidarrArtist.foreignArtistId || "").trim() || null;
    const mappedMbid = dbOps.getLidarrArtistMbid(foreignArtistId);
    const mbid =
      mappedMbid || (foreignArtistId && UUID_REGEX.test(foreignArtistId) ? foreignArtistId : null);
    const normalizedArtistId =
      Number.isSafeInteger(artistId) && artistId > 0 ? String(artistId) : null;
    const monitorOption = lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || "none";
    const normalizedMonitorOption = monitorOption || "none";
    return {
      id: normalizedArtistId,
      mbid,
      foreignArtistId,
      artistName: lidarrArtist.artistName,
      path: artistPath,
      addedAt: lidarrArtist.added || new Date().toISOString(),
      monitored: lidarrArtist.monitored || false,
      monitorOption: normalizedMonitorOption,
      monitorNewItems: lidarrArtist.monitorNewItems || "none",
      addOptions: {
        monitor: normalizedMonitorOption,
      },
      quality: lidarrArtist.qualityProfile?.name || "standard",
      albumFolders: true,
      statistics: lidarrArtist.statistics || {
        albumCount: 0,
        trackCount: 0,
        sizeOnDisk: 0,
      },
    };
  }

  async resolveLidarrArtistMbid(lidarrArtist) {
    const providerId = String(lidarrArtist?.foreignArtistId || "").trim();
    const artistName = String(lidarrArtist?.artistName || "").trim();
    if (!providerId || !artistName || UUID_REGEX.test(providerId)) return null;

    const existingMbid = dbOps.getLidarrArtistMbid(providerId);
    if (existingMbid) return existingMbid;

    const mbid = await musicbrainzResolveArtistMbidByName(artistName);
    if (!UUID_REGEX.test(String(mbid || ""))) return null;

    const identity = await musicbrainzGetArtistIdentityByMbid(mbid);
    const identityName = String(identity?.name || "").trim();
    const normalizedArtistName = artistName.toLowerCase();
    const acceptedArtistNames = new Set(
      [identityName, ...(Array.isArray(identity?.aliases) ? identity.aliases : [])]
        .map((name) => String(name || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const providerIds = Array.isArray(identity?.providerIds) ? identity.providerIds : [];
    const matchesProviderId = providerIds.some(
      (value) => String(value || "").trim().toLowerCase() === providerId.toLowerCase(),
    );
    if (!identityName || !acceptedArtistNames.has(normalizedArtistName) || !matchesProviderId) {
      return null;
    }

    try {
      dbOps.setLidarrArtistIdMap(mbid, providerId);
      return mbid;
    } catch (error) {
      if (error?.code !== "LIDARR_ARTIST_ID_CONFLICT") throw error;
      return null;
    }
  }

  async backfillLidarrArtistMappings(lidarrArtists) {
    const candidates = [];
    const seen = new Set();
    for (const artist of Array.isArray(lidarrArtists) ? lidarrArtists : []) {
      const providerId = String(artist?.foreignArtistId || "").trim();
      if (
        !providerId ||
        UUID_REGEX.test(providerId) ||
        seen.has(providerId) ||
        dbOps.getLidarrArtistMbid(providerId)
      ) {
        continue;
      }
      seen.add(providerId);
      candidates.push(artist);
    }

    await mapWithConcurrency(candidates, 2, (artist) => {
      const providerId = String(artist?.foreignArtistId || "").trim();
      let mappingRequest = _artistMappingInflight.get(providerId);
      if (!mappingRequest) {
        mappingRequest = this.resolveLidarrArtistMbid(artist)
          .catch(() => null)
          .finally(() => {
            if (_artistMappingInflight.get(providerId) === mappingRequest) {
              _artistMappingInflight.delete(providerId);
            }
          });
        _artistMappingInflight.set(providerId, mappingRequest);
      }
      return mappingRequest;
    });
  }

  async updateArtist(mbid, updates) {
    const canonicalArtist = canonicalArtistFallback(mbid);
    if (updates?.managedBy === "aurral" || canonicalArtist?.managedBy === "aurral") {
      const requestedMode = updates?.monitorOption ??
        (updates?.monitored === false ? "none" : canonicalArtist?.monitorMode || "all");
      return this.setAurralArtistMonitoring(mbid, requestedMode);
    }
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (updates.monitored !== undefined || updates.monitorOption !== undefined) {
        const monitorOption = updates.monitorOption || lidarrArtist.monitor || "none";
        const normalizedMonitorOption = monitorOption || "none";
        await lidarr.updateArtistMonitoring(lidarrArtist.id, monitorOption);
        logger.info('library', `[LibraryManager] Updated Lidarr monitoring for "${lidarrArtist.artistName}" to "${monitorOption}"`);
        const updated = await lidarr.getArtist(lidarrArtist.id);
        const mapped = this.mapLidarrArtist(updated);
        mapped.monitorOption = normalizedMonitorOption;
        mapped.addOptions = {
          ...(mapped.addOptions || {}),
          monitor: normalizedMonitorOption,
        };
        upsertCachedArtist(mapped);
        scheduleCanonicalLibraryReconciliation();
        return mapped;
      }
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      logger.error('library', `[LibraryManager] Failed to update artist in Lidarr: ${error.message}`);      return { error: error.message };
    }
  }

  async deleteArtist(mbid, deleteFiles = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured" };
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist) return { success: false, error: "Artist not found in Lidarr" };
      await lidarr.deleteArtist(lidarrArtist.id, deleteFiles);
      dbOps.deleteLidarrArtistIdMap(mbid);
      removeCachedArtistByMbid(mbid);
      clearCanonicalLidarrArtist(mbid);
      clearCanonicalLidarrArtist(lidarrArtist.foreignArtistId);
      scheduleCanonicalLibraryReconciliation();
      logger.info('library', `[LibraryManager] Deleted artist "${lidarrArtist.artistName}" from Lidarr`);
      return { success: true };
    } catch (error) {
      logger.error('library', `[LibraryManager] Failed to delete artist from Lidarr: ${error.message}`);      return { success: false, error: error.message };
    }
  }

  async _finishAurralAlbum(albumReference, options = {}) {
    const library = canonicalLibraryForAlbum(albumReference);
    const album = library.albums[0];
    if (!album) {
      return { error: "Album was not found in the canonical library", statusCode: 404 };
    }

    const artist = library.artists.find((entry) => entry.id === album.artistId);
    const mappedAlbum = mapCanonicalAlbum(album, artist, library.tracks);
    const albumMbid = album.mbid || album.releaseGroupMbid || null;
    const albumTracks = library.tracks.filter((track) => album.trackIds.includes(track.id));
    const allAlbumJobs = findAurralAlbumJobs(albumMbid);
    const requestGroupId =
      options.requestGroupId ||
      allAlbumJobs.find((job) => job.requestGroupId)?.requestGroupId ||
      randomUUID();
    const albumTrackTitles = albumTracks.map((track) => track.title).filter(Boolean);
    const missingTracks = albumTracks.filter((track) => track.available !== true);
    const sourceConfigured = isAnyDownloadSourceConfigured();
    const jobIds = [];
    const trackedJobIds = [];
    let blockedTracks = 0;

    for (const track of missingTracks) {
      const relation = (track.albums || []).find((entry) => entry.albumId === album.id);
      const matchingJobs = findAurralAlbumJobs(albumMbid).filter((job) => jobMatchesTrack(job, track));
      const activeJob = matchingJobs.find((job) =>
        job.status === "pending" || job.status === "downloading" || job.status === "cancel_requested",
      );
      if (activeJob) {
        trackedJobIds.push(activeJob.id);
        continue;
      }

      const completedJob = matchingJobs.find((job) => job.status === "done");
      if (completedJob) {
        const stat = completedJob.finalPath
          ? await fsp.stat(completedJob.finalPath).catch(() => null)
          : null;
        if (stat?.isFile()) {
          trackedJobIds.push(completedJob.id);
          scheduleLibraryScan({
            includeLidarr: false,
            changedPaths: [completedJob.finalPath],
          });
          continue;
        }
        if (!sourceConfigured) {
          downloadTracker.setFailed(completedJob.id, "Completed file is missing");
          continue;
        }
        if (downloadTracker.setPending(completedJob.id, "Completed file is missing", {
          asRetryCycle: true,
        })) {
          jobIds.push(completedJob.id);
          trackedJobIds.push(completedJob.id);
        }
        continue;
      }

      if (!sourceConfigured) continue;

      const retryJob = matchingJobs.find((job) => job.status === "failed" || job.status === "cancelled");
      if (retryJob) {
        restoreDownloadJobCancellations([retryJob.id]);
        if (downloadTracker.setPending(retryJob.id, "Retrying missing Aurral album track", {
          asRetryCycle: true,
        })) {
          jobIds.push(retryJob.id);
          trackedJobIds.push(retryJob.id);
        }
        continue;
      }

      if (matchingJobs.some((job) => job.status === "blocked")) {
        blockedTracks += 1;
        continue;
      }

      const jobId = downloadTracker.addJob(
        {
          artistName: artist?.name || album.albumArtist || "Unknown Artist",
          trackName: track.title,
          albumName: album.title,
          artistMbid: artist?.mbid || null,
          albumMbid,
          trackMbid: track.mbid || null,
          releaseYear: album.releaseDate ? String(album.releaseDate).slice(0, 4) : null,
          durationMs: track.metadata?.durationMs,
          trackNumber: relation?.trackNumber || 0,
          albumTrackCount: albumTracks.length,
          albumTrackTitles,
          artistAliases: artist?.metadata?.aliases || [],
          managedBy: "aurral",
          requestGroupId,
          reason: "Aurral album request",
        },
        "library",
      );
      if (jobId) {
        jobIds.push(jobId);
        trackedJobIds.push(jobId);
      }
    }

    const uniqueTrackedJobIds = [...new Set(trackedJobIds)];
    const shouldStartWorker = uniqueTrackedJobIds.some((jobId) => {
      const status = downloadTracker.getJob(jobId)?.status;
      return status === "pending" || status === "downloading";
    });
    if (shouldStartWorker) {
      try {
        const { recordTrackJobQueued } = await import("./aurralHistoryService.js");
        for (const jobId of jobIds) {
          const job = downloadTracker.getJob(jobId);
          if (job) recordTrackJobQueued(job);
        }
      } catch {}
      try {
        const { weeklyFlowWorker } = await import("./weeklyFlow/weeklyFlowWorker.js");
        await weeklyFlowWorker.start();
      } catch (error) {
        logger.warn("library", "Aurral album jobs remain queued after worker start failed", {
          message: error?.message || String(error),
        });
      }
    }

    const available = mappedAlbum.statistics.percentOfTracks >= 100;
    return {
      ...mappedAlbum,
      jobIds: uniqueTrackedJobIds,
      requestGroupId: uniqueTrackedJobIds.length > 0 ? requestGroupId : null,
      missingTrackCount: missingTracks.length,
      queuedTrackCount: jobIds.length,
      blockedTrackCount: blockedTracks,
      albumStatus: this._summarizeAurralAlbum(album, library.tracks),
      status: available
        ? "available"
        : uniqueTrackedJobIds.length > 0
          ? "queued"
          : blockedTracks > 0 || (!sourceConfigured && missingTracks.length > 0)
            ? "blocked"
            : "inLibrary",
    };
  }

  async planAurralArtistMonitoring(artist, mode, { monitorStartedAt = null } = {}) {
    if (mode === "none" || (mode === "future" && !monitorStartedAt)) {
      return { mode, releaseGroupIds: [], releases: [], skipped: [] };
    }
    let releases;
    try {
      releases = await listAurralArtistReleases(artist.mbid);
    } catch (error) {
      logger.warn("library", "Aurral monitoring could not load artist releases", {
        artistMbid: artist.mbid,
        message: error?.message || String(error),
      });
      return {
        error: "Artist releases are unavailable; monitoring was not changed",
        statusCode: 503,
        code: "metadata_unavailable",
      };
    }
    const selected = [];
    const skipped = [];
    for (const release of selectAurralReleases(releases, mode, { monitorStartedAt })) {
      const existing = canonicalAlbumForReference(release.id);
      const override = existing
        ? getLibraryManagementEntry("album", Number(existing.id))
        : null;
      if (existing?.managedBy === "lidarr") {
        skipped.push({ releaseGroupId: release.id, reason: "managed_by_lidarr" });
      } else if (override?.monitorMode === "unmonitored") {
        skipped.push({ releaseGroupId: release.id, reason: "unmonitored" });
      } else if (existing && existing.statistics.percentOfTracks >= 100) {
        skipped.push({ releaseGroupId: release.id, reason: "complete" });
      } else {
        selected.push({ id: release.id, title: release.title, existing: Boolean(existing) });
      }
    }
    return {
      mode,
      releaseGroupIds: selected.map((release) => release.id),
      releases: selected,
      skipped,
    };
  }

  _enqueueAurralReleaseAcquisition(artist, plan) {
    if (!plan.releases?.length) return false;
    enqueueSystemTaskJob({
      kind: "aurral-monitoring-apply",
      artistMbid: artist.mbid,
      releaseGroups: plan.releases.map(({ id, title }) => ({ id, title })),
    });
    return true;
  }

  async startAurralArtistMonitoring(artist, mode) {
    const plan = await this.planAurralArtistMonitoring(artist, mode);
    if (plan.error) return plan;
    const queued = this._enqueueAurralReleaseAcquisition(artist, plan);
    const { releases: _releases, ...summary } = plan;
    return { ...summary, queued };
  }

  async setAurralArtistMonitoring(mbid, requestedMode) {
    const resolvedMode = resolveAurralMonitorMode(requestedMode);
    if (resolvedMode.error) return resolvedMode;
    const { mode } = resolvedMode;
    const artist = canonicalArtistFallback(mbid);
    if (!artist) {
      return { error: "Artist not found in the canonical library", statusCode: 404 };
    }
    if (artist.managedBy && artist.managedBy !== "aurral") {
      return {
        error: `Artist is managed by ${artist.managedBy}`,
        statusCode: 409,
        code: "artist_owner_conflict",
        managedBy: artist.managedBy,
      };
    }
    const plan = await this.planAurralArtistMonitoring(artist, mode);
    if (plan.error) return plan;
    if (artist.managedBy !== "aurral" || artist.monitorMode !== mode) {
      setLibraryManagement({
        entityKind: "artist",
        entityId: Number(artist.id),
        managedBy: "aurral",
        monitorMode: mode,
      });
    }
    const queued = this._enqueueAurralReleaseAcquisition(artist, plan);
    const { releases: _releases, ...summary } = plan;
    return {
      ...(canonicalArtistFallback(artist.id) || artist),
      monitored: mode !== "none",
      monitorOption: mode,
      monitoring: { ...summary, queued },
    };
  }

  async acquireAurralReleases({ artistMbid, releaseGroups = [] } = {}) {
    const results = [];
    for (const release of releaseGroups) {
      const existing = canonicalAlbumForReference(release.id);
      const override = existing ? getLibraryManagementEntry("album", Number(existing.id)) : null;
      if (existing?.managedBy === "lidarr" || override?.monitorMode === "unmonitored") {
        results.push({ releaseGroupId: release.id, status: "skipped" });
        continue;
      }
      try {
        const album = await this._addAurralAlbum(artistMbid, release.id, release.title);
        if (album?.error) {
          logger.warn("library", "Aurral monitoring could not acquire an album", {
            artistMbid,
            releaseGroupId: release.id,
            message: album.error,
          });
        }
        results.push({
          releaseGroupId: release.id,
          status: album?.error ? "failed" : album.albumStatus?.status || album.status,
        });
      } catch (error) {
        logger.warn("library", "Aurral monitoring could not acquire an album", {
          artistMbid,
          releaseGroupId: release.id,
          message: error?.message || String(error),
        });
        results.push({ releaseGroupId: release.id, status: "failed" });
      }
    }
    return results;
  }

  async reconcileAurralMonitoring() {
    const monitoredArtists = [...getManagedByMap("artist").entries()].filter(
      ([, entry]) => entry.managedBy === "aurral" && entry.monitorMode && entry.monitorMode !== "none",
    );
    let queuedAlbums = 0;
    let failedArtists = 0;
    for (const [artistId, entry] of monitoredArtists) {
      const artist = canonicalArtistFallback(artistId);
      if (!artist?.mbid) continue;
      const plan = await this.planAurralArtistMonitoring(artist, entry.monitorMode, {
        monitorStartedAt: entry.updatedAt,
      });
      if (plan.error) {
        failedArtists += 1;
        continue;
      }
      const newReleases = plan.releases.filter((release) => !release.existing);
      if (newReleases.length === 0) continue;
      await this.acquireAurralReleases({ artistMbid: artist.mbid, releaseGroups: newReleases });
      queuedAlbums += newReleases.length;
    }
    logger.info("library", "Aurral monitoring reconciliation finished", {
      artists: monitoredArtists.length,
      queuedAlbums,
      failedArtists,
    });
    return { artists: monitoredArtists.length, queuedAlbums, failedArtists };
  }

  _resolveAurralAlbum(canonicalId) {
    const reference = String(canonicalId ?? "").trim();
    const id = Number(reference);
    if (!/^\d+$/.test(reference) || !Number.isSafeInteger(id) || id <= 0) {
      return {
        error: "canonicalId must be a positive integer",
        statusCode: 400,
        code: "invalid_canonical_id",
      };
    }
    const library = canonicalLibraryForAlbum(id);
    const album = library.albums.find((entry) => entry.id === id);
    if (!album) {
      return { error: "Album was not found in the canonical library", statusCode: 404 };
    }
    const artist = library.artists.find((entry) => entry.id === album.artistId);
    const mappedAlbum = mapCanonicalAlbum(album, artist, library.tracks);
    if (mappedAlbum.managedBy !== "aurral") {
      return buildAlbumConflict(mappedAlbum);
    }
    return { album, artist, library, mappedAlbum };
  }

  _summarizeAurralAlbum(album, tracks) {
    const sourceConfigured = isAnyDownloadSourceConfigured();
    return {
      managedBy: "aurral",
      ...summarizeAurralAlbum({
        tracks: tracks.filter((track) => album.trackIds.includes(track.id)),
        jobs: findAurralAlbumJobs(album.mbid || album.releaseGroupMbid),
        sourceConfigured,
        sourceMessage: sourceConfigured ? null : getDownloadSourceNotConfiguredMessage(),
      }),
    };
  }

  async setAurralAlbumMonitoring(canonicalId, { monitored } = {}) {
    if (typeof monitored !== "boolean") {
      return { error: "monitored must be true or false", statusCode: 400, code: "invalid_monitored" };
    }
    const resolved = this._resolveAurralAlbum(canonicalId);
    if (resolved.error) return resolved;
    const { album, mappedAlbum } = resolved;
    setLibraryManagement({
      entityKind: "album",
      entityId: album.id,
      managedBy: "aurral",
      monitorMode: monitored ? "monitored" : "unmonitored",
    });
    if (monitored) {
      const result = await this._finishAurralAlbum(album.id);
      if (result?.error) return result;
      return { ...result, monitored: true };
    }
    const cancellation = await cancelAurralAlbumJobs(album.mbid || album.releaseGroupMbid);
    return {
      ...mappedAlbum,
      monitored: false,
      ...cancellation,
      albumStatus: this.getAurralAlbumStatus(album.id),
    };
  }

  getAurralAlbumStatus(canonicalId) {
    const resolved = this._resolveAurralAlbum(canonicalId);
    if (resolved.error) return resolved;
    const { album, library, mappedAlbum } = resolved;
    return {
      canonicalId: mappedAlbum.canonicalId,
      ...this._summarizeAurralAlbum(album, library.tracks),
    };
  }

  async cancelAurralAlbum(canonicalId) {
    const resolved = this._resolveAurralAlbum(canonicalId);
    if (resolved.error) return resolved;
    const { album, mappedAlbum } = resolved;
    const result = await cancelAurralAlbumJobs(album.mbid || album.releaseGroupMbid);
    return {
      canonicalId: mappedAlbum.canonicalId,
      managedBy: "aurral",
      ...result,
    };
  }

  async _addAurralAlbum(artistId, releaseGroupMbid, albumName, options = {}) {
    const normalizedAlbumMbid = String(releaseGroupMbid || "").trim();
    const artist = canonicalArtistFallback(artistId);
    if (!artist) {
      return { error: "Artist not found in the canonical library", statusCode: 404 };
    }
    if (!normalizedAlbumMbid) {
      return { error: "releaseGroupMbid is required", statusCode: 400 };
    }

    const existing = canonicalAlbumForReference(normalizedAlbumMbid);
    if (existing && String(existing.artistId) !== String(artist.id)) {
      return buildAlbumConflict(existing, "Album identity already belongs to a different artist");
    }
    if (existing?.managedBy && existing.managedBy !== "aurral") {
      return buildAlbumConflict(existing);
    }
    if (existing) {
      const existingLibrary = canonicalLibraryForAlbum(existing.id);
      if (existingLibrary.tracks.length > 0) {
        if (!existing.managedBy) {
          setLibraryManagement({
            entityKind: "album",
            entityId: existing.id,
            managedBy: "aurral",
            monitorMode: options.monitorMode || options.monitorOption || null,
          });
        }
        return this._finishAurralAlbum(existing.id, options);
      }
    }

    let metadata;
    try {
      metadata = await getMetadataAlbumByMbid(normalizedAlbumMbid);
    } catch (error) {
      logger.warn("library", "Aurral album metadata lookup failed", {
        mbid: normalizedAlbumMbid,
        message: error?.message || String(error),
      });
      return {
        error: "Album metadata is unavailable; the request can be retried",
        statusCode: 503,
        code: "metadata_unavailable",
      };
    }
    if (metadata?.id && String(metadata.id).trim().toLowerCase() !== normalizedAlbumMbid.toLowerCase()) {
      return {
        error: "Album metadata does not unambiguously identify the requested album",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }

    const providerArtists = Array.isArray(metadata?.artists) ? metadata.artists : [];
    const providerArtistIds = [metadata?.artistId, ...providerArtists.map((entry) => entry?.id)]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    const artistMbid = String(artist.mbid || "").trim().toLowerCase();
    if (artistMbid && providerArtistIds.length > 0 && !providerArtistIds.includes(artistMbid)) {
      return {
        error: "Album metadata does not unambiguously identify the requested artist",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }

    const selectedRelease =
      metadata?.releases?.find(
        (release) =>
          String(release?.status || "").toLowerCase() === "official" &&
          Array.isArray(release?.tracks) &&
          release.tracks.length > 0,
      ) ||
      metadata?.releases?.find((release) => Array.isArray(release?.tracks) && release.tracks.length > 0) ||
      metadata?.releases?.[0] ||
      null;
    const tracks = (Array.isArray(selectedRelease?.tracks) ? selectedRelease.tracks : [])
      .map((track) => ({
        ...track,
        trackMbid: String(track?.recordingId || track?.id || "").trim(),
        title: String(track?.title || "").trim(),
      }))
      .filter((track) => track.trackMbid && track.title);
    if (tracks.length === 0) {
      return {
        error: "Album metadata does not contain an unambiguous track list",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }

    const providerArtist =
      providerArtists.find((entry) => String(entry?.id || "").trim().toLowerCase() === artistMbid) ||
      providerArtists[0] ||
      null;
    const resolvedAlbumName = String(metadata?.title || albumName || "").trim();
    if (!resolvedAlbumName) {
      return {
        error: "Album metadata does not contain an unambiguous album name",
        statusCode: 422,
        code: "ambiguous_identity",
      };
    }
    const monitorMode =
      options.monitorMode ||
      options.monitorOption ||
      getLibraryManagementEntry("album", existing?.id)?.monitorMode ||
      null;
    const albumRecord = upsertLibraryAlbum({
      identityKey: buildIdentityKey("release-group", normalizedAlbumMbid),
      mbid: normalizedAlbumMbid,
      releaseGroupMbid: normalizedAlbumMbid,
      artistId: artist.id,
      title: resolvedAlbumName,
      albumArtist: artist.name || providerArtist?.name || null,
      releaseDate: metadata?.releaseDate || selectedRelease?.releaseDate || null,
      metadata: {
        id: normalizedAlbumMbid,
        foreignAlbumId: normalizedAlbumMbid,
        librarySource: "aurral",
        added: existing?.metadata?.added || new Date().toISOString(),
        monitored: options.monitored !== false,
        monitor: monitorMode || "none",
        monitorOption: monitorMode || "none",
        albumType: metadata?.type || "Album",
        secondaryTypes: metadata?.secondaryTypes || [],
        genres: metadata?.genres || [],
        images: metadata?.images || [],
      },
    });

    for (const track of tracks) {
      const trackRecord = upsertLibraryTrack({
        identityKey: buildIdentityKey("recording", track.trackMbid),
        mbid: track.trackMbid,
        title: track.title,
        artistName: artist.name || providerArtist?.name || null,
        metadata: {
          id: track.trackMbid,
          foreignRecordingId: track.trackMbid,
          foreignTrackId: track.id || track.trackMbid,
          librarySource: "aurral",
          durationMs: track.durationMs,
          mediumNumber: track.mediumNumber,
          trackNumber: track.trackPosition || track.trackNumber || 0,
        },
      });
      linkLibraryAlbumTrack({
        albumId: albumRecord.id,
        trackId: trackRecord.id,
        discNumber: track.mediumNumber || 1,
        trackNumber: track.trackPosition || track.trackNumber || 0,
      });
    }

    setLibraryManagement({
      entityKind: "album",
      entityId: albumRecord.id,
      managedBy: "aurral",
      monitorMode,
    });
    return this._finishAurralAlbum(albumRecord.id, options);
  }

  async addAlbum(artistId, releaseGroupMbid, albumName, options = {}) {
    let managedBy;
    try {
      managedBy = await this.resolveManagedBy(options.managedBy, options.user);
    } catch (error) {
      return {
        error: error.message,
        statusCode: error.statusCode || 400,
        code: error.code || null,
      };
    }
    const albumKey = String(releaseGroupMbid || "")
      .trim()
      .toLowerCase();
    if (!albumKey) {
      return managedBy === "aurral"
        ? this._addAurralAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy })
        : this._addAlbum(artistId, releaseGroupMbid, albumName, { ...options, managedBy });
    }

    const existingRequest = _albumAddInflight.get(albumKey);
    if (existingRequest) {
      const result = await existingRequest;
      if (result?.managedBy && result.managedBy !== managedBy) {
        return buildAlbumConflict(result);
      }
      if (result?.artistId != null && String(result.artistId) !== String(artistId)) {
        return {
          ...buildAlbumConflict(result, ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR),
        };
      }
      return result;
    }

    const add = managedBy === "aurral" ? this._addAurralAlbum : this._addAlbum;
    const request = add.call(this, artistId, releaseGroupMbid, albumName, {
      ...options,
      managedBy,
    }).finally(
      () => {
        if (_albumAddInflight.get(albumKey) === request) {
          _albumAddInflight.delete(albumKey);
        }
      },
    );
    _albumAddInflight.set(albumKey, request);
    return request;
  }

  async _addAlbum(artistId, releaseGroupMbid, albumName, options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const isArtistNotReadyError = (error) => {
        const msg = String(error?.message || "").toLowerCase();
        return msg.includes("404") || msg.includes("not found") || msg.includes("artist with id");
      };
      const isAlbumAlreadyAddedError = (error) => {
        const msg = String(error?.message || "").toLowerCase();
        return (
          msg.includes("this album has already been added") ||
          msg.includes("albumexistsvalidator") ||
          msg.includes("foreignalbumid") ||
          msg.includes("unique constraint")
        );
      };
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      const shouldTriggerSearch =
        options.triggerSearch === true || (options.triggerSearch === undefined && searchOnAdd);
      const mapExistingAlbum = async (existingAlbum, fallbackArtist = null) => {
        if (!existingAlbum) return null;
        if (!existingAlbum.monitored) {
          await lidarr.monitorAlbum(existingAlbum.id, true);
        }
        if (shouldTriggerSearch) {
          await lidarr.triggerAlbumSearch(existingAlbum.id);
          await this.ensureRequestedAlbumMonitoring(artistId, existingAlbum.id);
          this.scheduleRequestedAlbumMonitoringRepair(artistId, existingAlbum.id);
        }
        const refreshedExisting = await lidarr
          .getAlbum(existingAlbum.id)
          .catch(() => existingAlbum);
        const refreshedArtist = await lidarr.getArtist(artistId).catch(() => fallbackArtist);
        if (!refreshedArtist) return null;
        const mapped = this.mapLidarrAlbum(refreshedExisting, refreshedArtist);
        scheduleCanonicalLibraryReconciliation();
        return mapped;
      };
      let lidarrArtist = null;
      const artistResolveAttempts = 8;
      const artistResolveDelayMs = 1250;
      for (let attempt = 1; attempt <= artistResolveAttempts; attempt++) {
        try {
          lidarrArtist = await lidarr.getArtist(artistId);
        } catch (error) {
          if (attempt < artistResolveAttempts && isArtistNotReadyError(error)) {
            await sleep(artistResolveDelayMs);
            continue;
          }
          throw error;
        }
        if (lidarrArtist) break;
        if (attempt < artistResolveAttempts) {
          await sleep(artistResolveDelayMs);
        }
      }
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (lidarrArtist.monitored === false) {
        lidarrArtist = await lidarr.updateArtistMonitoring(
          artistId,
          lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || "none",
        );
      }
      const existing = await lidarr.getAlbumByMbid(releaseGroupMbid, {
        forceRefresh: true,
      });
      const artistNumericId = parseInt(artistId, 10);
      const sameArtistExisting =
        existing && String(existing.artistId) === String(artistNumericId) ? existing : null;
      if (existing?.artistId != null && !sameArtistExisting) {
        return {
          error: ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR,
          statusCode: 409,
        };
      }
      if (sameArtistExisting) {
        const mappedExisting = await mapExistingAlbum(sameArtistExisting, lidarrArtist);
        if (mappedExisting) return mappedExisting;
        return { error: "Failed to resolve existing album in Lidarr" };
      }
      let lidarrAlbum = null;
      const addAlbumAttempts = 4;
      const addAlbumDelayMs = 1500;
      for (let attempt = 1; attempt <= addAlbumAttempts; attempt++) {
        try {
          lidarrAlbum = await lidarr.addAlbum(artistId, releaseGroupMbid, albumName, {
            monitored: true,
            triggerSearch:
              options.triggerSearch === true ||
              (options.triggerSearch === undefined && searchOnAdd),
          });
          break;
        } catch (error) {
          if (isAlbumAlreadyAddedError(error)) {
            const existingAfterConflict =
              (await this.waitForAlbumByMbidForArtist(releaseGroupMbid, artistNumericId, {
                delaysMs: [500, 1000, 2000, 4000],
              })) ||
              (await lidarr
                .getAlbumByMbid(releaseGroupMbid, { forceRefresh: true })
                .catch(() => null));
            const sameArtistAfterConflict =
              existingAfterConflict &&
              String(existingAfterConflict.artistId) === String(artistNumericId)
                ? existingAfterConflict
                : null;
            if (sameArtistAfterConflict) {
              const mappedConflictAlbum = await mapExistingAlbum(
                sameArtistAfterConflict,
                lidarrArtist,
              );
              if (mappedConflictAlbum) return mappedConflictAlbum;
            }
            if (existingAfterConflict?.artistId != null) {
              return {
                error: ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR,
                statusCode: 409,
              };
            }
          }
          if (attempt < addAlbumAttempts && isArtistNotReadyError(error)) {
            await sleep(addAlbumDelayMs);
            continue;
          }
          throw error;
        }
      }
      if (!lidarrAlbum) {
        return { error: "Failed to add album to Lidarr" };
      }
      if (shouldTriggerSearch) {
        await this.ensureRequestedAlbumMonitoring(artistId, lidarrAlbum.id);
        this.scheduleRequestedAlbumMonitoringRepair(artistId, lidarrAlbum.id);
        lidarrAlbum = await lidarr.getAlbum(lidarrAlbum.id).catch(() => lidarrAlbum);
      }
      const updatedArtist = await lidarr.getArtist(artistId);
      const mapped = this.mapLidarrAlbum(lidarrAlbum, updatedArtist);
      scheduleCanonicalLibraryReconciliation();
      return mapped;
    } catch (error) {
      logger.error('library', `[LibraryManager] Failed to add album to Lidarr: ${error.message}`);      return { error: error.message };
    }
  }

  async requestAlbumFromSearch({
    albumMbid,
    albumName,
    artistMbid,
    artistName,
    triggerSearch = false,
    user = null,
    managedBy: requestedManagedBy = null,
  } = {}) {
    const managedBy = await this.resolveManagedBy(requestedManagedBy, user);
    const normalizedAlbumMbid = String(albumMbid || "").trim();
    const normalizedAlbumName = String(albumName || "").trim();
    const normalizedArtistMbid = String(artistMbid || "").trim();
    const normalizedArtistName = String(artistName || "").trim();

    if (!normalizedAlbumMbid || !normalizedAlbumName) {
      const error = new Error("albumMbid and albumName are required");
      error.statusCode = 400;
      throw error;
    }
    if (!normalizedArtistMbid || !normalizedArtistName) {
      const error = new Error("artistMbid and artistName are required");
      error.statusCode = 400;
      throw error;
    }

    if (managedBy === "aurral") {
      const existingAlbum = canonicalAlbumForReference(normalizedAlbumMbid);
      let artist = await this.getArtist(normalizedArtistMbid, {
        managedBy: "aurral",
      });
      let createdArtist = false;

      if (existingAlbum?.managedBy && existingAlbum.managedBy !== "aurral") {
        throwLibraryError(buildAlbumConflict(existingAlbum));
      }
      if (existingAlbum && artist && String(existingAlbum.artistId) !== String(artist.id)) {
        throwLibraryError(
          buildAlbumConflict(existingAlbum, "Album identity already belongs to a different artist"),
        );
      }

      if (!artist) {
        if (!hasPermission(user, "addArtist")) {
          const error = new Error("Permission required: addArtist to create the album artist");
          error.statusCode = 403;
          throw error;
        }
        const created = await this.addArtistWithResolvedOptions(
          normalizedArtistMbid,
          normalizedArtistName,
          {
            managedBy: "aurral",
            user,
            monitorOption: "none",
            albumOnly: true,
            albumMbid: normalizedAlbumMbid,
            triggerSearch: false,
          },
        );
        throwLibraryError(created);
        artist = created;
        createdArtist = true;
      }

      if (!artist?.id) {
        const error = new Error("Failed to resolve artist in the canonical library");
        error.statusCode = 503;
        throw error;
      }

      const album = await this.addAlbum(artist.id, normalizedAlbumMbid, normalizedAlbumName, {
        managedBy: "aurral",
        user,
        triggerSearch: triggerSearch === true,
      });
      throwLibraryError(album);
      return {
        success: true,
        artist,
        album,
        createdArtist,
        createdAlbum: !existingAlbum,
        triggeredSearch: Boolean(album?.jobIds?.length),
        status: album.status,
        managedBy: "aurral",
        jobIds: album.jobIds || [],
        requestGroupId: album.requestGroupId || null,
        albumStatus: album.albumStatus || null,
      };
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      const error = new Error("Lidarr is not configured");
      error.statusCode = 503;
      throw error;
    }

    const settings = getSettings();
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const shouldTriggerSearch = triggerSearch === true || searchOnAdd;

    let artist = await this.getArtist(normalizedArtistMbid, { managedBy });
    let createdArtist = false;

    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        const error = new Error("Permission required: addArtist to create the album artist");
        error.statusCode = 403;
        throw error;
      }

      const resolvedArtistAddOptions = await this.resolveArtistAddOptions({
        user,
        managedBy,
      });
      if (resolvedArtistAddOptions?.error) {
        const error = new Error(resolvedArtistAddOptions.error);
        error.statusCode = 503;
        throw error;
      }
      const created = await this.addArtistWithResolvedOptions(
        normalizedArtistMbid,
        normalizedArtistName,
        {
          ...resolvedArtistAddOptions,
          user,
          managedBy,
          albumOnly: true,
          albumMbid: normalizedAlbumMbid,
          triggerSearch: shouldTriggerSearch,
        },
      );
      if (created?.error) {
        const error = new Error(created.error);
        error.statusCode = 503;
        throw error;
      }
      artist = created;
      createdArtist = true;
    }

    if (!artist?.id) {
      const error = new Error("Failed to resolve artist in Lidarr");
      error.statusCode = 503;
      throw error;
    }

    artist = await this.ensureArtistMonitored(artist);

    let existingAlbum = await lidarr.getAlbumByMbid(normalizedAlbumMbid, {
      forceRefresh: true,
    });
    if (
      existingAlbum &&
      existingAlbum.artistId != null &&
      String(existingAlbum.artistId) !== String(artist.id)
    ) {
      const error = new Error(ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR);
      error.statusCode = 409;
      throw error;
    }

    const album = await this.addAlbum(artist.id, normalizedAlbumMbid, normalizedAlbumName, {
      managedBy,
      user,
      triggerSearch: shouldTriggerSearch,
    });

    if (album?.error) {
      const error = new Error(album.error);
      error.statusCode =
        Number.isInteger(album.statusCode) && album.statusCode >= 400
          ? album.statusCode
          : 503;
      throw error;
    }

    const albumStatus =
      (album.statistics?.percentOfTracks ?? 0) >= 100 || (album.statistics?.sizeOnDisk ?? 0) > 0
        ? "available"
        : shouldTriggerSearch
          ? "searching"
          : "inLibrary";

    return {
      success: true,
      artist,
      album,
      createdArtist,
      createdAlbum: !existingAlbum,
      triggeredSearch: shouldTriggerSearch,
      status: albumStatus,
    };
  }

  async getAlbums(artistId, lidarrArtist = null, options = {}) {
    const canonicalArtist = canonicalArtistFallback(artistId);
    if (normalizeLibraryManager(options.managedBy) === "aurral" ||
      (options.managedBy == null && canonicalArtist?.managedBy === "aurral")) {
      return canonicalAlbumsForArtist(artistId);
    }
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return canonicalAlbumsForArtist(artistId);
    }
    try {
      const resolvedArtist = lidarrArtist || (await lidarr.getArtist(artistId));
      if (!resolvedArtist) {
        return [];
      }
      const allAlbums = await lidarr.request(
        `/album?artistId=${encodeURIComponent(artistId)}`,
        "GET",
        null,
        false,
        options,
      );
      const artistAlbums = Array.isArray(allAlbums)
        ? allAlbums.filter((a) => a.artistId === parseInt(artistId))
        : [];
      return artistAlbums.map((a) => this.mapLidarrAlbum(a, resolvedArtist));
    } catch (error) {
      if (isLidarrNotFoundError(error)) return [];
      logger.error('library', `[LibraryManager] Failed to fetch albums from Lidarr: ${error.message}`);
      return canonicalAlbumsForArtist(artistId);
    }
  }

  async getAlbumById(id, { managedBy = null } = {}) {
    const canonical = canonicalAlbumForReference(id);
    if (normalizeLibraryManager(managedBy) === "aurral" ||
      (managedBy == null && canonical?.managedBy === "aurral")) return canonical;
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return canonical;
    if (!id || id === "undefined" || id === "null") {
      return null;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(id);
      if (!lidarrAlbum) return managedBy == null ? canonical : null;
      const lidarrArtist = await lidarr.getArtist(lidarrAlbum.artistId);
      return this.mapLidarrAlbum(lidarrAlbum, lidarrArtist);
    } catch (error) {
      if (isLidarrNotFoundError(error)) return managedBy == null ? canonical : null;
      return canonical;
    }
  }

  mapLidarrAlbum(lidarrAlbum, lidarrArtist) {
    const albumPath =
      lidarrAlbum.path ??
      (lidarrArtist.path
        ? path.join(lidarrArtist.path, this.sanitizePath(lidarrAlbum.title))
        : null);

    const rawStats = lidarrAlbum.statistics || {};
    let percentOfTracks = rawStats.percentOfTracks;

    if (percentOfTracks !== undefined) {
      if (percentOfTracks > 1 && percentOfTracks <= 100) {
        percentOfTracks = Math.round(percentOfTracks);
      } else if (percentOfTracks <= 1 && percentOfTracks >= 0) {
        percentOfTracks = Math.round(percentOfTracks * 100);
      } else if (percentOfTracks > 100) {
        percentOfTracks = Math.min(100, Math.round(percentOfTracks / 10));
      }
    }

    return {
      id: lidarrAlbum.id?.toString() || lidarrAlbum.foreignAlbumId,
      artistId: lidarrAlbum.artistId?.toString() || lidarrArtist.id?.toString(),
      artistName: lidarrArtist.name ?? null,
      mbid: lidarrAlbum.foreignAlbumId,
      foreignAlbumId: lidarrAlbum.foreignAlbumId,
      albumName: lidarrAlbum.title,
      path: albumPath,
      addedAt: lidarrAlbum.added || new Date().toISOString(),
      releaseDate: lidarrAlbum.releaseDate || null,
      monitored: lidarrAlbum.monitored || false,
      statistics: {
        trackCount: rawStats.trackCount || 0,
        sizeOnDisk: rawStats.sizeOnDisk || 0,
        percentOfTracks: percentOfTracks || 0,
      },
    };
  }

  async updateAlbum(id, updates) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    const maxAttempts = 3;
    const delayMs = 1500;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const lidarrAlbum = await lidarr.getAlbum(id);
        if (!lidarrAlbum) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          return { error: "Album not found in Lidarr" };
        }
        if (updates.monitored !== undefined) {
          await lidarr.monitorAlbum(id, updates.monitored);
        }
        const updated = await lidarr.getAlbum(id);
        const lidarrArtist = await lidarr.getArtist(updated.artistId);
        const mapped = this.mapLidarrAlbum(updated, lidarrArtist);
        scheduleCanonicalLibraryReconciliation();
        return mapped;
      } catch (error) {
        const msg = error.message || "";
        const isTransient =
          msg.includes("503") ||
          msg.includes("502") ||
          msg.includes("504") ||
          msg.includes("Service Unavailable") ||
          msg.includes("Bad Gateway") ||
          msg.includes("Gateway Timeout");
        if (isTransient && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        logger.error('library', `[LibraryManager] Failed to update album in Lidarr: ${error.message}`);        return { error: error.message };
      }
    }
    return { error: "Album not found in Lidarr" };
  }

  async deleteAlbum(id, deleteFiles = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured" };
    }
    try {
      await lidarr.deleteAlbum(id, deleteFiles);
      clearCanonicalLidarrAlbum(id);
      scheduleCanonicalLibraryReconciliation();
      return { success: true };
    } catch (error) {
      logger.error('library', `[LibraryManager] Failed to delete album from Lidarr: ${error.message}`);      return { success: false, error: error.message };
    }
  }

  async deleteTrack(id) {
    try {
      const library = getCanonicalTrack({
        trackId: id,
        availableOnly: false,
      });
      const track = library.tracks.find((entry) => String(entry.id) === String(id));
      if (!track) return { success: false, code: "not_found", error: "Track not found" };

      const aurralFiles = track.files.filter((file) => file.source === "aurral" && file.path);
      const lidarrFiles = track.files.filter((file) => file.source === "lidarr" && file.available);
      if (aurralFiles.length > 0 && lidarrFiles.length === 0) {
        let committedPaths;
        try {
          committedPaths = await removeLibraryDownloadJobs(track);
        } catch (error) {
          logger.error("library", `[LibraryManager] Failed to cancel track downloads: ${error.message}`);
          return {
            success: false,
            code: "download_cancellation_failed",
            error: error.message,
          };
        }
        const paths = [...new Set([
          ...aurralFiles.map((file) => file.path),
          ...committedPaths,
        ])];
        try {
          const deletionResults = await Promise.allSettled(paths.map(async (filePath) => {
            const removal = await removePlaylistFileIfUnshared(filePath, "library", {
              deleteIfUnshared: true,
              protectPlayback: false,
            });
            if (removal.action === "skipped") {
              const resolvedPath = path.resolve(filePath);
              const referencedByAnotherJob = downloadTracker.getAll().some((job) =>
                job.status === "done" &&
                typeof job.finalPath === "string" &&
                path.resolve(job.finalPath) === resolvedPath,
              );
              if (!referencedByAnotherJob) {
                try {
                  await fsp.unlink(filePath);
                } catch (error) {
                  if (error?.code !== "ENOENT") throw error;
                }
              }
            }
            return filePath;
          }));
          const reconciledPaths = deletionResults
            .filter((result) => result.status === "fulfilled")
            .map((result) => result.value);
          if (reconciledPaths.length > 0) {
            markLibraryMediaFilesUnavailable("aurral", reconciledPaths);
          }
          const failure = deletionResults.find((result) => result.status === "rejected");
          if (failure) {
            const error = failure.reason;
            logger.error("library", `[LibraryManager] Failed to delete Aurral track file: ${error.message}`);
            return { success: false, code: "failed", error: error.message };
          }
          removeLibraryTrackIfNoAvailableMedia(id);
          return { success: true };
        } catch (error) {
          logger.error("library", `[LibraryManager] Failed to delete Aurral track file: ${error.message}`);
          return { success: false, code: "failed", error: error.message };
        }
      }

      const lidarr = await getLidarrClient();
      if (!lidarr || !lidarr.isConfigured()) {
        return { success: false, code: "lidarr_unavailable", error: "Lidarr is not configured" };
      }
      const lidarrLibrary = getCanonicalTrack({
        trackId: id,
        source: "lidarr",
        availableOnly: false,
      });
      const lidarrTrack = lidarrLibrary.tracks.find((entry) => String(entry.id) === String(id));
      if (!lidarrTrack) return { success: false, code: "not_found", error: "Track not found" };

      const metadata = lidarrTrack.metadata || {};
      let trackFileId = Number(
        metadata.trackFileId || metadata.trackFile?.id || metadata.file?.id,
      );
      if (!Number.isFinite(trackFileId)) {
        const trackAlbums = Array.isArray(lidarrTrack.albums) ? lidarrTrack.albums : [];
        const album = lidarrLibrary.albums.find((entry) =>
          trackAlbums.some((relation) => String(relation.albumId) === String(entry.id)),
        );
        const lidarrAlbumId = Number(album?.metadata?.id);
        if (Number.isFinite(lidarrAlbumId)) {
          const lidarrTracks = await lidarr.getTracksByAlbumId(lidarrAlbumId);
          const match = lidarrTracks.find((entry) =>
            [entry.id, entry.foreignRecordingId, entry.foreignTrackId].some(
              (candidate) =>
                String(candidate ?? "") === String(metadata.id ?? track.mbid ?? ""),
            ),
          );
          trackFileId = Number(match?.trackFileId);
        }
      }
      if (!Number.isFinite(trackFileId)) {
        return {
          success: false,
          code: "not_found",
          error: "Track file not found in Lidarr",
        };
      }

      await lidarr.deleteTrackFile(trackFileId);
      scheduleCanonicalLibraryReconciliation();
      return { success: true };
    } catch (error) {
      logger.error('library', `[LibraryManager] Failed to delete track file: ${error.message}`);
      const status = error?.response?.status;
      const code = status === 404
        ? "not_found"
        : !error?.response || status >= 500
          ? "lidarr_unavailable"
          : "failed";
      return { success: false, code, error: error.message };
    }
  }

  async addTrack(albumId, trackMbid, trackName, trackNumber, options = {}) {
    const album = await this.getAlbumById(albumId);
    if (!album) {
      throw new Error("Album not found");
    }

    const tracks = await this.getTracks(albumId);
    const existing = tracks.find((t) => t.mbid === trackMbid);
    if (existing) {
      return existing;
    }

    return {
      id: `${albumId}-${trackNumber}`,
      albumId,
      artistId: album.artistId,
      mbid: trackMbid,
      trackName,
      trackNumber,
      path: null,
      quality: options.quality || null,
      size: 0,
      addedAt: new Date().toISOString(),
      hasFile: false,
    };
  }

  async getTracks(albumId, { managedBy = null } = {}) {
    if (!albumId || albumId === "undefined") {
      return [];
    }

    const canonicalAlbum = canonicalAlbumForReference(albumId);
    if (normalizeLibraryManager(managedBy) === "aurral" ||
      (managedBy == null && canonicalAlbum?.managedBy === "aurral")) {
      return canonicalTracksForAlbum(albumId);
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return canonicalTracksForAlbum(albumId);
    }

    const key = String(albumId);
    const cached = _tracksCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.tracks;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(albumId);
      if (!lidarrAlbum) return managedBy == null ? canonicalTracksForAlbum(albumId) : [];

      const rawPercent = lidarrAlbum.statistics?.percentOfTracks || 0;
      const albumSizeOnDisk = lidarrAlbum.statistics?.sizeOnDisk || 0;
      let normalizedPercent = rawPercent;

      if (rawPercent > 1 && rawPercent <= 100) {
        normalizedPercent = Math.round(rawPercent);
      } else if (rawPercent <= 1 && rawPercent >= 0) {
        normalizedPercent = Math.round(rawPercent * 100);
      } else if (rawPercent > 100) {
        normalizedPercent = Math.min(100, Math.round(rawPercent / 10));
      }

      const isAlbumComplete = normalizedPercent >= 100 || albumSizeOnDisk > 0;

      let rawTracks = [];

      if (
        lidarrAlbum.tracks &&
        Array.isArray(lidarrAlbum.tracks) &&
        lidarrAlbum.tracks.length > 0
      ) {
        rawTracks = lidarrAlbum.tracks;
      } else if (lidarrAlbum.albumReleases && lidarrAlbum.albumReleases.length > 0) {
        for (const release of lidarrAlbum.albumReleases) {
          if (release.tracks && Array.isArray(release.tracks) && release.tracks.length > 0) {
            rawTracks = release.tracks;
            break;
          }
        }
      } else if (
        lidarrAlbum.media &&
        Array.isArray(lidarrAlbum.media) &&
        lidarrAlbum.media.length > 0
      ) {
        const allTracks = [];
        for (const medium of lidarrAlbum.media) {
          if (medium.tracks && Array.isArray(medium.tracks)) {
            allTracks.push(...medium.tracks);
          }
        }
        if (allTracks.length > 0) {
          rawTracks = allTracks;
        }
      }

      if (rawTracks.length === 0) {
        const lidarrTracks = await lidarr.getTracksByAlbumId(albumId);
        if (lidarrTracks && lidarrTracks.length > 0) {
          rawTracks = lidarrTracks;
        }
      }

      let trackFileById = new Map();
      if (
        albumNeedsTrackFiles({
          albumSizeOnDisk,
          isAlbumComplete,
          tracks: rawTracks,
        })
      ) {
        const trackFiles = await lidarr.getTrackFilesByAlbumId(albumId);
        trackFileById = buildTrackFileIndex(trackFiles);
      }

      const result = rawTracks.map((track, index) =>
        this.mapLidarrTrack(
          enrichLidarrTrackWithFiles(track, trackFileById),
          lidarrAlbum,
          index + 1,
          isAlbumComplete,
        ),
      );

      if (_tracksCache.size >= TRACKS_CACHE_MAX) {
        const firstKey = _tracksCache.keys().next().value;
        if (firstKey !== undefined) _tracksCache.delete(firstKey);
      }
      _tracksCache.set(key, {
        tracks: result,
        expires: Date.now() + TRACKS_CACHE_TTL_MS,
      });
      return result;
    } catch (error) {
      if (cached) {
        return cached.tracks;
      }
      if (isLidarrNotFoundError(error)) {
        return managedBy == null ? canonicalTracksForAlbum(albumId) : [];
      }
      logger.error('library', `[LibraryManager] Failed to fetch tracks from Lidarr: ${error.message}`);
      return canonicalTracksForAlbum(albumId);
    }
  }

  async getPlaybackQueue({ page = 1, pageSize = 100 } = {}) {
    return buildPlaybackQueueFromCanonicalLibrary(
      getCanonicalLibraryPage({
        source: "all",
        availableOnly: true,
        kind: "tracks",
        page,
        pageSize,
      }),
    );
  }

  mapLidarrTrack(lidarrTrack, lidarrAlbum, trackNumber = 0, _albumIsComplete = false) {
    const trackFile = lidarrTrack.trackFile || lidarrTrack.file || null;
    const filePath =
      lidarrTrack.path ||
      trackFile?.path ||
      (trackFile?.relativePath && lidarrAlbum.path
        ? path.join(lidarrAlbum.path, trackFile.relativePath)
        : null) ||
      null;
    const size =
      lidarrTrack.sizeOnDisk || lidarrTrack.size || trackFile?.size || trackFile?.sizeOnDisk || 0;
    return {
      id:
        lidarrTrack.id?.toString() ||
        lidarrTrack.foreignRecordingId ||
        `${lidarrAlbum.id}-${trackNumber}`,
      albumId: lidarrAlbum.id?.toString(),
      artistId: lidarrAlbum.artistId?.toString() || lidarrAlbum.artist?.id?.toString(),
      mbid: lidarrTrack.foreignRecordingId || lidarrTrack.foreignTrackId,
      trackName: lidarrTrack.title || lidarrTrack.trackTitle,
      trackNumber: trackNumber || lidarrTrack.trackNumber || 0,
      path: filePath,
      hasFile: !!filePath,
      size: size,
      quality:
        lidarrTrack.mediaInfo?.audioFormat ||
        trackFile?.mediaInfo?.audioFormat ||
        lidarrTrack.quality?.quality?.name ||
        trackFile?.quality?.quality?.name ||
        null,
      addedAt: lidarrTrack.added || trackFile?.dateAdded || new Date().toISOString(),
    };
  }

  async updateTrack(id, updates) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(id.split("-")[0]);
      if (!lidarrAlbum) return null;
      const tracks = await this.getTracks(lidarrAlbum.id.toString());
      const track = tracks.find((t) => t.id === id);
      if (!track) return null;
      return { ...track, ...updates };
    } catch {
      return null;
    }
  }

  sanitizePath(name) {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export const libraryManager = new LibraryManager();
