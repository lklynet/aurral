import path from "path";
import { UUID_REGEX } from "../../lib/uuid.js";
import { dbOps, userOps } from "../db/helpers/index.js";
import { hasPermission } from "../middleware/auth.js";
import {
  iterateCanonicalArtistProjection,
  getCanonicalLibraryPage,
  getCanonicalTrack,
  invalidateCanonicalLibraryCache,
} from "./libraryQueryService.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";
import {
  clearCanonicalLidarrAlbum,
  clearCanonicalLidarrArtist,
} from "./libraryMediaStore.js";
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
const _artistMonitoringRepairs = new Map();
const _albumAddInflight = new Map();
const _artistMappingInflight = new Map();
const ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR =
  "Album already exists in Lidarr under a different artist";

function scheduleCanonicalLibraryReconciliation() {
  invalidateCanonicalLibraryCache();
  return scheduleLibraryScan({ includeLidarr: true });
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
    .then(({ enqueueSystemTaskJob }) => {
      enqueueSystemTaskJob({ kind: "lidarr-retry" }, { delaySeconds: 60 });
    })
    .catch((err) => { logger.warn('library', err); });
}

export function getCachedArtistCount() {
  return Array.isArray(_cachedArtists) ? _cachedArtists.length : 0;
}

export function getCachedArtists() {
  return Array.isArray(_cachedArtists) ? _cachedArtists : [];
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

export function buildPlaybackQueueFromLidarrData({
  artists = [],
  rawAlbums = [],
  rawTracks = [],
  rawTrackFiles = [],
} = {}) {
  const artistNameById = new Map(
    artists.map((artist) => [
      String(artist.id),
      artist.artistName || artist.name || "Unknown Artist",
    ]),
  );

  const albumMetaById = new Map();
  for (const album of Array.isArray(rawAlbums) ? rawAlbums : []) {
    const albumId = String(album.id);
    const artistId = String(album.artistId);
    albumMetaById.set(albumId, {
      title: album.title || "Unknown Album",
      artistId,
      artistName: artistNameById.get(artistId) || "Unknown Artist",
    });
  }

  const trackFileById = buildTrackFileIndex(rawTrackFiles);
  const queue = [];
  const seen = new Set();

  for (const track of Array.isArray(rawTracks) ? rawTracks : []) {
    if (track?.hasFile !== true && !Number.isFinite(Number(track?.trackFileId))) {
      continue;
    }

    const enriched = enrichLidarrTrackWithFiles(track, trackFileById);
    const filePath = enriched.path || enriched.trackFile?.path || null;
    if (!filePath) continue;

    const albumId = String(track.albumId);
    const albumMeta = albumMetaById.get(albumId);
    if (!albumMeta) continue;

    const trackId = String(track.id);
    if (seen.has(trackId)) continue;
    seen.add(trackId);

    const streamFormat = path.extname(filePath).replace(/^\./, "").toLowerCase();

    queue.push({
      id: `lib-${albumMeta.artistId}-${albumId}-${trackId}`,
      title: track.title || track.trackTitle || "Unknown Track",
      artist: albumMeta.artistName,
      album: albumMeta.title,
      streamPath: `/library/file-stream/${encodeURIComponent(albumId)}/${encodeURIComponent(trackId)}`,
      streamFormat: streamFormat || null,
      quality:
        enriched.trackFile?.quality?.quality?.name ||
        enriched.trackFile?.mediaInfo?.audioFormat ||
        null,
      trackNumber: track.trackNumber || track.absoluteTrackNumber || 0,
    });
  }

  queue.sort((a, b) => {
    const artistCmp = a.artist.localeCompare(b.artist);
    if (artistCmp !== 0) return artistCmp;
    const albumCmp = a.album.localeCompare(b.album);
    if (albumCmp !== 0) return albumCmp;
    return (a.trackNumber || 0) - (b.trackNumber || 0);
  });

  return queue;
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
      const file = (track.files || []).find(
        (entry) =>
          entry.available &&
          entry.source === "lidarr" &&
          (entry.albumId == null || entry.albumId === album.id),
      );
      if (!file) continue;
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
  async addArtist(mbid, artistName, options = {}) {
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
          const existing = await this.getArtist(mbid);
          if (existing) {
            return existing;
          }
        } catch {}
      }
      logger.error('library', `[LibraryManager] Failed to add artist to Lidarr: ${error.message}`);      return { error: error.message };
    }
  }

  async resolveArtistAddOptions(options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }

    const settings = getSettings();
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
    if (!albumOnly && requestedMonitorOption !== "none") {
      const albums = await this.getAlbums(artist.id, null, { forceRefresh: true });
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

  async getArtist(mbid) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }
    const cachedArtist = findCachedArtistByMbid(mbid);
    if (cachedArtist) {
      return cachedArtist;
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist) return null;
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
      return mappedArtist;
    } catch {
      return null;
    }
  }

  async getArtistById(id) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }
    try {
      const lidarrArtist = await lidarr.getArtist(id);
      await this.backfillLidarrArtistMappings([lidarrArtist]);
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      return null;
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
        if (_lastLidarrFailureAt && Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS) {
          scheduleLidarrRetry();
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
        return Array.isArray(_cachedArtists) ? _cachedArtists.slice(0, limit) : [];
      }
      if (_lastLidarrFailureAt && Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS) {
        scheduleLidarrRetry();
        return Array.isArray(_cachedArtists) ? _cachedArtists.slice(0, limit) : [];
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
        return Array.isArray(_cachedArtists) ? _cachedArtists.slice(0, normalizedLimit) : [];
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
      return mapped;
    } catch (_) {
      return Array.isArray(_cachedArtists) ? _cachedArtists.slice(0, limit) : [];
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

  async addAlbum(artistId, releaseGroupMbid, albumName, options = {}) {
    const albumKey = String(releaseGroupMbid || "")
      .trim()
      .toLowerCase();
    if (!albumKey) {
      return this._addAlbum(artistId, releaseGroupMbid, albumName, options);
    }

    const existingRequest = _albumAddInflight.get(albumKey);
    if (existingRequest) {
      const result = await existingRequest;
      if (result?.artistId != null && String(result.artistId) !== String(artistId)) {
        return {
          error: ALBUM_OWNED_BY_DIFFERENT_ARTIST_ERROR,
          statusCode: 409,
        };
      }
      return result;
    }

    const request = this._addAlbum(artistId, releaseGroupMbid, albumName, options).finally(
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
  } = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      const error = new Error("Lidarr is not configured");
      error.statusCode = 503;
      throw error;
    }

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

    const settings = getSettings();
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const shouldTriggerSearch = triggerSearch === true || searchOnAdd;

    let artist = await this.getArtist(normalizedArtistMbid);
    let createdArtist = false;

    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        const error = new Error("Permission required: addArtist to create the album artist");
        error.statusCode = 403;
        throw error;
      }

      const resolvedArtistAddOptions = await this.resolveArtistAddOptions({
        user,
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
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return [];
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
      logger.error('library', `[LibraryManager] Failed to fetch albums from Lidarr: ${error.message}`);      return [];
    }
  }

  async getAlbumById(id) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }
    if (!id || id === "undefined" || id === "null") {
      return null;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(id);
      if (!lidarrAlbum) {
        return null;
      }
      const lidarrArtist = await lidarr.getArtist(lidarrAlbum.artistId);
      return this.mapLidarrAlbum(lidarrAlbum, lidarrArtist);
    } catch (error) {
      if (error.response?.status === 404 || error.message?.includes("404")) {
        return null;
      }
      return null;
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
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, code: "lidarr_unavailable", error: "Lidarr is not configured" };
    }
    try {
      const library = getCanonicalTrack({
        trackId: id,
        source: "lidarr",
        availableOnly: false,
      });
      const track = library.tracks.find((entry) => String(entry.id) === String(id));
      if (!track) return { success: false, code: "not_found", error: "Track not found" };

      const metadata = track.metadata || {};
      let trackFileId = Number(
        metadata.trackFileId || metadata.trackFile?.id || metadata.file?.id,
      );
      if (!Number.isFinite(trackFileId)) {
        const trackAlbums = Array.isArray(track.albums) ? track.albums : [];
        const album = library.albums.find((entry) =>
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

  async getTracks(albumId) {
    if (!albumId || albumId === "undefined") {
      return [];
    }

    const key = String(albumId);
    const cached = _tracksCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.tracks;
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return [];
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(albumId);
      if (!lidarrAlbum) {
        return [];
      }

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
      if (error.message && error.message.includes("404")) {
        return [];
      }
      logger.error('library', `[LibraryManager] Failed to fetch tracks from Lidarr: ${error.message}`);      return [];
    }
  }

  async getPlaybackQueue({ page = 1, pageSize = 100 } = {}) {
    return buildPlaybackQueueFromCanonicalLibrary(
      getCanonicalLibraryPage({
        source: "lidarr",
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
