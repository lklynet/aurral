import fs from "fs/promises";
import path from "path";
import { dbOps, userOps } from "../config/db-helpers.js";
import { dbHelpers } from "../config/db-sqlite.js";
import { hasPermission } from "../middleware/auth.js";
import {
  musicbrainzRequest,
  musicbrainzGetArtistReleaseGroups,
} from "./apiClients.js";

const LIDARR_RETRY_MS = 60000;
const FULL_LIST_FALLBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const TRACKS_CACHE_TTL_MS = 120000;
const TRACKS_CACHE_MAX = 300;
const PLAYBACK_QUEUE_CACHE_TTL_MS = 120000;

let lidarrClient = null;
let _cachedArtists = [];
let _lastLidarrFailureAt = 0;
let _retryTimeoutId = null;
let _lastFullArtistFetchAt = 0;
const _tracksCache = new Map();
let _playbackQueueCache = null;

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
    (track) =>
      track?.hasFile === true || Number.isFinite(Number(track?.trackFileId)),
  );
}

function findCachedArtistByMbid(mbid) {
  if (!mbid || !Array.isArray(_cachedArtists) || _cachedArtists.length === 0) {
    return null;
  }
  return (
    _cachedArtists.find(
      (artist) =>
        artist?.mbid === mbid || artist?.foreignArtistId === mbid,
    ) || null
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

function scheduleLidarrRetry(instance) {
  if (_retryTimeoutId) return;
  _retryTimeoutId = setTimeout(() => {
    _retryTimeoutId = null;
    instance.getAllArtists().catch(() => {});
  }, LIDARR_RETRY_MS);
}

export function getCachedArtistCount() {
  return Array.isArray(_cachedArtists) ? _cachedArtists.length : 0;
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

function getTrackFileTrackIds(file) {
  if (Array.isArray(file?.trackIds) && file.trackIds.length > 0) {
    return file.trackIds;
  }
  if (file?.trackId != null) {
    return [file.trackId];
  }
  return [];
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
      artist.artistName || "Unknown Artist",
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

  const trackMetaById = new Map();
  for (const track of Array.isArray(rawTracks) ? rawTracks : []) {
    trackMetaById.set(String(track.id), {
      title: track.title || track.trackTitle || "Unknown Track",
      albumId: String(track.albumId),
      trackNumber: track.trackNumber || 0,
    });
  }

  const queue = [];
  for (const file of Array.isArray(rawTrackFiles) ? rawTrackFiles : []) {
    if (!file.path) continue;
    const albumId = String(file.albumId);
    const albumMeta = albumMetaById.get(albumId);
    if (!albumMeta) continue;

    for (const rawTrackId of getTrackFileTrackIds(file)) {
      const trackId = String(rawTrackId);
      const trackMeta = trackMetaById.get(trackId);
      if (!trackMeta) continue;

      const streamFormat = path
        .extname(file.path)
        .replace(/^\./, "")
        .toLowerCase();

      queue.push({
        id: `lib-${albumMeta.artistId}-${albumId}-${trackId}`,
        title: trackMeta.title,
        artist: albumMeta.artistName,
        album: albumMeta.title,
        streamPath: `/library/file-stream/${encodeURIComponent(albumId)}/${encodeURIComponent(trackId)}`,
        streamFormat: streamFormat || null,
        quality:
          file.quality?.quality?.name ||
          file.mediaInfo?.audioFormat ||
          null,
        trackNumber: trackMeta.trackNumber,
      });
    }
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

export { buildTrackFileIndex, enrichLidarrTrackWithFiles, albumNeedsTrackFiles };

export class LibraryManager {
  async addArtist(mbid, artistName, options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    const isArtistAlreadyAddedError = (error) => {
      const message = String(error?.message || "").toLowerCase();
      return (
        message.includes("artistexistsvalidator") ||
        message.includes("already been added")
      );
    };
    try {
      const lidarrSettings = getSettings();
      const lidarrArtist = await lidarr.addArtist(mbid, artistName, {
        albumOnly: options.albumOnly === true,
        monitorOption: options.monitorOption || "none",
        rootFolderPath: options.rootFolderPath,
        savedRootFolderPath: options.savedRootFolderPath,
        qualityProfileId: options.qualityProfileId,
        savedQualityProfileId: options.savedQualityProfileId,
        tagId: options.tagId,
        metadataProfileId:
          options.metadataProfileId ||
          lidarrSettings.integrations?.lidarr?.metadataProfileId,
      });
      console.log(`[LibraryManager] Added artist "${artistName}" to Lidarr`);
      const mappedArtist = this.mapLidarrArtist(lidarrArtist);
      upsertCachedArtist(mappedArtist);
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
      console.error(
        `[LibraryManager] Failed to add artist to Lidarr: ${error.message}`,
      );
      return { error: error.message };
    }
  }

  async resolveArtistAddOptions(options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }

    const settings = getSettings();
    const defaultMonitorOption =
      settings.integrations?.lidarr?.defaultMonitorOption || "none";
    const requestedMonitorOption =
      options.monitorOption && options.monitorOption !== "none"
        ? options.monitorOption
        : defaultMonitorOption;
    const currentUser =
      options.user?.id != null ? userOps.getUserById(options.user.id) : null;
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
      rootFolderPath: preparedAddOptions?.resolved?.rootFolderPath || null,
      qualityProfileId: preparedAddOptions?.resolved?.qualityProfileId ?? null,
      tagId: options.tagId ?? null,
      preparedAddOptions,
    };
  }

  async waitForArtistAlbums(artistId) {
    const attempts = 20;
    const delayMs = 1500;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const albums = await this.getAlbums(artistId);
      if (albums.length > 0) return albums;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  async waitForAlbumByMbidForArtist(
    albumMbid,
    artistId,
    { attempts = 20, delayMs = 1500 } = {},
  ) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return null;
    }

    const normalizedAlbumMbid = String(albumMbid || "").trim();
    const normalizedArtistId = String(artistId || "").trim();
    if (!normalizedAlbumMbid || !normalizedArtistId) {
      return null;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const album = await lidarr.getAlbumByMbid(normalizedAlbumMbid);
        if (album && String(album.artistId) === normalizedArtistId) {
          return album;
        }
      } catch {}

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
  }

  async applyArtistMonitoringDefaults(artist, albums = null) {
    if (
      !artist?.monitored ||
      !artist?.monitorOption ||
      artist.monitorOption === "none"
    ) {
      return;
    }

    const lidarr = await getLidarrClient();
    let eligibleAlbums = Array.isArray(albums)
      ? albums
      : await this.waitForArtistAlbums(artist.id);

    if (lidarr && lidarr.isConfigured() && artist?.id) {
      try {
        const lidarrArtist = await lidarr.getArtist(artist.id);
        const settings = getSettings();
        const fallbackMetadataProfileId =
          settings.integrations?.lidarr?.metadataProfileId;
        const metadataProfileId =
          lidarrArtist?.metadataProfileId ||
          lidarrArtist?.metadataProfile?.id ||
          fallbackMetadataProfileId;
        const profiles = metadataProfileId
          ? await lidarr.getMetadataProfiles()
          : null;
        const metadataProfile = Array.isArray(profiles)
          ? profiles.find(
              (profile) => String(profile?.id) === String(metadataProfileId),
            )
          : null;

        let allowedPrimaryTypes = null;
        if (metadataProfile?.primaryAlbumTypes) {
          const allowed = new Set();
          for (const item of metadataProfile.primaryAlbumTypes) {
            const name = getMetadataProfileTypeName(item);
            if (!name) continue;
            const isAllowed =
              typeof item === "string" ? true : item.allowed !== false;
            if (!isAllowed) continue;
            allowed.add(normalizeReleaseTypeName(name));
          }
          if (allowed.size > 0) {
            allowedPrimaryTypes = allowed;
          }
        }

        if (allowedPrimaryTypes) {
          const mbid =
            artist.mbid || artist.foreignArtistId || artist.id?.toString?.();
          const releaseGroups = mbid
            ? await musicbrainzGetArtistReleaseGroups(mbid)
            : [];
          const mbidToType = new Map(
            releaseGroups.map((rg) => [
              rg.id,
              normalizeReleaseTypeName(rg["primary-type"]),
            ]),
          );
          eligibleAlbums = eligibleAlbums.filter((album) => {
            const key =
              album.mbid || album.foreignAlbumId || album.id?.toString?.();
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
            console.error(
              `Failed to monitor/search album ${album.albumName}:`,
              err.message,
            );
          }
        }),
      );
    }
  }

  async addArtistWithResolvedOptions(mbid, artistName, options = {}) {
    const requestedMonitorOption = options.monitorOption || "none";
    const artist = await this.addArtist(mbid, artistName, {
      quality: options.quality,
      monitorOption: requestedMonitorOption,
      rootFolderPath: options.rootFolderPath,
      qualityProfileId: options.qualityProfileId,
      tagId: options.tagId,
    });
    if (artist?.error) {
      return artist;
    }
    if (requestedMonitorOption !== "none") {
      const albums = await this.waitForArtistAlbums(artist.id);
      await this.applyArtistMonitoringDefaults(artist, albums);
    }
    return artist;
  }

  async addArtistWithPreferences(mbid, artistName, options = {}) {
    const resolvedOptions = await this.resolveArtistAddOptions(options);
    if (resolvedOptions?.error) {
      return resolvedOptions;
    }
    return this.addArtistWithResolvedOptions(mbid, artistName, resolvedOptions);
  }

  async fetchArtistAlbums(artistId, mbid) {
    try {
      const lidarr = await getLidarrClient();
      let allowedPrimaryTypes = null;
      if (lidarr && lidarr.isConfigured()) {
        try {
          const lidarrArtist = await lidarr.getArtist(artistId);
          const settings = getSettings();
          const fallbackMetadataProfileId =
            settings.integrations?.lidarr?.metadataProfileId;
          const metadataProfileId =
            lidarrArtist?.metadataProfileId ||
            lidarrArtist?.metadataProfile?.id ||
            fallbackMetadataProfileId;
          if (metadataProfileId) {
            const profiles = await lidarr.getMetadataProfiles();
            const profile = Array.isArray(profiles)
              ? profiles.find(
                  (item) => String(item?.id) === String(metadataProfileId),
                )
              : null;
            if (profile?.primaryAlbumTypes) {
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
              const allowed = new Set();
              for (const item of profile.primaryAlbumTypes) {
                const name = getTypeName(item);
                if (!name) continue;
                const isAllowed =
                  typeof item === "string" ? true : item.allowed !== false;
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
        const normalizeTypeName = (value) =>
          String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
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
          console.error(`Failed to add album ${rg.title}:`, result.error);
        }
      }
    } catch (error) {
      console.error(
        `Failed to fetch albums for artist ${mbid}:`,
        error.message,
      );
    }
  }

  async fetchAlbumTracks(albumId, releaseGroupMbid) {
    try {
      const rgData = await musicbrainzRequest(
        `/release-group/${releaseGroupMbid}`,
        {
          inc: "releases",
        },
      );

      if (rgData.releases && rgData.releases.length > 0) {
        const releaseId = rgData.releases[0].id;

        const releaseData = await musicbrainzRequest(`/release/${releaseId}`, {
          inc: "recordings",
        });

        let tracksAdded = 0;
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
                    tracksAdded++;
                  } catch (err) {
                    if (!err.message.includes("already exists")) {
                      console.error(
                        `Failed to add track ${recording.title}:`,
                        err.message,
                      );
                    }
                  }
                }
              }
            }
          }
        }

        if (tracksAdded > 0) {
          await this.updateAlbumStatistics(albumId);
        }
      }
    } catch (error) {
      console.error(
        `Failed to fetch tracks for album ${releaseGroupMbid}:`,
        error.message,
      );
    }
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
      monitorOption ||
      artist.monitorOption ||
      artist.addOptions?.monitor ||
      "none";
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

    for (const delayMs of [1000, 3000, 8000, 15000]) {
      const timeout = setTimeout(() => {
        this.ensureRequestedAlbumMonitoring(
          normalizedArtistId,
          normalizedAlbumId,
          options,
        ).catch((error) => {
          console.error(
            `[LibraryManager] Failed to stabilize requested album monitoring: ${error.message}`,
          );
        });
      }, delayMs);
      timeout.unref?.();
    }
  }

  async getAllArtists() {
    try {
      const lidarr = await getLidarrClient();
      if (!lidarr || !lidarr.isConfigured()) {
        return _cachedArtists;
      }
      if (
        _lastLidarrFailureAt &&
        Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS
      ) {
        scheduleLidarrRetry(this);
        return _cachedArtists;
      }
      try {
        const lidarrArtists = await lidarr.request("/artist");
        _lastLidarrFailureAt = 0;
        if (!Array.isArray(lidarrArtists)) {
          return _cachedArtists;
        }
        _cachedArtists = lidarrArtists.map((a) => this.mapLidarrArtist(a));
        return _cachedArtists;
      } catch (error) {
        const wasHealthy = _lastLidarrFailureAt === 0;
        _lastLidarrFailureAt = Date.now();
        scheduleLidarrRetry(this);
        if (wasHealthy) {
          const msg = (error && error.message) || String(error);
          console.warn(
            "[LibraryManager] Lidarr unavailable:",
            msg,
            "- using cached artists (if any). Retrying every 60s.",
          );
        }
        return _cachedArtists;
      }
    } catch (_) {
      return _cachedArtists;
    }
  }

  async getRecentArtists(limit = 25, poolSize = 100) {
    try {
      const lidarr = await getLidarrClient();
      if (!lidarr || !lidarr.isConfigured()) {
        return Array.isArray(_cachedArtists)
          ? _cachedArtists.slice(0, limit)
          : [];
      }
      if (
        _lastLidarrFailureAt &&
        Date.now() - _lastLidarrFailureAt < LIDARR_RETRY_MS
      ) {
        scheduleLidarrRetry(this);
        return Array.isArray(_cachedArtists)
          ? _cachedArtists.slice(0, limit)
          : [];
      }
      const normalizedLimit = Math.max(0, limit);
      const normalizedPool = Math.max(normalizedLimit, poolSize);
      const pageSize = Math.max(normalizedPool * 2, normalizedPool);
      const history = await lidarr.getHistory(
        1,
        pageSize,
        "date",
        "descending",
      );
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
              _cachedArtists = lidarrArtists.map((a) =>
                this.mapLidarrArtist(a),
              );
              _lastFullArtistFetchAt = Date.now();
            }
          } catch {}
        }
        return Array.isArray(_cachedArtists)
          ? _cachedArtists.slice(0, normalizedLimit)
          : [];
      }
      const picked = artistIds
        .sort(() => 0.5 - Math.random())
        .slice(0, normalizedLimit);
      const artists = await Promise.all(
        picked.map((id) => lidarr.getArtist(id).catch(() => null)),
      );
      const mapped = artists
        .filter(Boolean)
        .map((artist) => this.mapLidarrArtist(artist));
      if (mapped.length >= normalizedLimit) return mapped;
      if (Array.isArray(_cachedArtists) && _cachedArtists.length > 0) {
        const existing = new Set(
          mapped.map(
            (artist) => artist.mbid || artist.foreignArtistId || artist.id,
          ),
        );
        const fallback = _cachedArtists.filter(
          (artist) =>
            !existing.has(artist.mbid || artist.foreignArtistId || artist.id),
        );
        const extra = fallback
          .sort(() => 0.5 - Math.random())
          .slice(0, Math.max(0, normalizedLimit - mapped.length));
        return [...mapped, ...extra];
      }
      return mapped;
    } catch (_) {
      return Array.isArray(_cachedArtists)
        ? _cachedArtists.slice(0, limit)
        : [];
    }
  }

  mapLidarrArtist(lidarrArtist) {
    const artistPath = lidarrArtist.path ?? null;
    const monitorOption =
      lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || "none";
    const normalizedMonitorOption = monitorOption || "none";
    return {
      id: lidarrArtist.id?.toString() || lidarrArtist.foreignArtistId,
      mbid: lidarrArtist.foreignArtistId,
      foreignArtistId: lidarrArtist.foreignArtistId,
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

  async updateArtist(mbid, updates) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (
        updates.monitored !== undefined ||
        updates.monitorOption !== undefined
      ) {
        const monitorOption =
          updates.monitorOption || lidarrArtist.monitor || "none";
        const normalizedMonitorOption = monitorOption || "none";
        await lidarr.updateArtistMonitoring(lidarrArtist.id, monitorOption);
        console.log(
          `[LibraryManager] Updated Lidarr monitoring for "${lidarrArtist.artistName}" to "${monitorOption}"`,
        );
        const updated = await lidarr.getArtist(lidarrArtist.id);
        const mapped = this.mapLidarrArtist(updated);
        mapped.monitorOption = normalizedMonitorOption;
        mapped.addOptions = {
          ...(mapped.addOptions || {}),
          monitor: normalizedMonitorOption,
        };
        if (mapped.monitored && mapped.monitorOption !== "none") {
          import("./monitoringService.js")
            .then(({ monitoringService }) => {
              monitoringService.processArtistMonitoring(mapped).catch((err) => {
                console.error(
                  `[LibraryManager] Error triggering monitoring for ${mapped.artistName}:`,
                  err.message,
                );
              });
            })
            .catch(() => {});
        }
        return mapped;
      }
      return this.mapLidarrArtist(lidarrArtist);
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to update artist in Lidarr: ${error.message}`,
      );
      return { error: error.message };
    }
  }

  async deleteArtist(mbid, deleteFiles = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured" };
    }
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist)
        return { success: false, error: "Artist not found in Lidarr" };
      await lidarr.deleteArtist(lidarrArtist.id, deleteFiles);
      removeCachedArtistByMbid(mbid);
      console.log(
        `[LibraryManager] Deleted artist "${lidarrArtist.artistName}" from Lidarr`,
      );
      return { success: true };
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to delete artist from Lidarr: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  async addAlbum(artistId, releaseGroupMbid, albumName, options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const isArtistNotReadyError = (error) => {
        const msg = String(error?.message || "").toLowerCase();
        return (
          msg.includes("404") ||
          msg.includes("not found") ||
          msg.includes("artist with id")
        );
      };
      const isAlbumAlreadyAddedError = (error) => {
        const msg = String(error?.message || "").toLowerCase();
        return (
          msg.includes("this album has already been added") ||
          msg.includes("albumexistsvalidator") ||
          msg.includes("foreignalbumid")
        );
      };
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      const shouldTriggerSearch =
        options.triggerSearch === true ||
        (options.triggerSearch === undefined && searchOnAdd);
      const mapExistingAlbum = async (existingAlbum, fallbackArtist = null) => {
        if (!existingAlbum) return null;
        if (!existingAlbum.monitored) {
          await lidarr.monitorAlbum(existingAlbum.id, true);
        }
        if (shouldTriggerSearch) {
          await lidarr.triggerAlbumSearch(existingAlbum.id);
          await this.ensureRequestedAlbumMonitoring(artistId, existingAlbum.id);
          this.scheduleRequestedAlbumMonitoringRepair(
            artistId,
            existingAlbum.id,
          );
        }
        const refreshedExisting = await lidarr
          .getAlbum(existingAlbum.id)
          .catch(() => existingAlbum);
        const refreshedArtist = await lidarr
          .getArtist(artistId)
          .catch(() => fallbackArtist);
        if (!refreshedArtist) return null;
        return this.mapLidarrAlbum(refreshedExisting, refreshedArtist);
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
      const existing = await lidarr.getAlbumByMbid(releaseGroupMbid);
      const artistNumericId = parseInt(artistId, 10);
      const sameArtistExisting =
        existing && String(existing.artistId) === String(artistNumericId)
          ? existing
          : null;
      if (sameArtistExisting) {
        const mappedExisting = await mapExistingAlbum(
          sameArtistExisting,
          lidarrArtist,
        );
        if (mappedExisting) return mappedExisting;
        return { error: "Failed to resolve existing album in Lidarr" };
      }
      let lidarrAlbum = null;
      const addAlbumAttempts = 4;
      const addAlbumDelayMs = 1500;
      for (let attempt = 1; attempt <= addAlbumAttempts; attempt++) {
        try {
          lidarrAlbum = await lidarr.addAlbum(
            artistId,
            releaseGroupMbid,
            albumName,
            {
              monitored: true,
              triggerSearch:
                options.triggerSearch === true ||
                (options.triggerSearch === undefined && searchOnAdd),
            },
          );
          break;
        } catch (error) {
          if (isAlbumAlreadyAddedError(error)) {
            const existingAfterConflict =
              (await this.waitForAlbumByMbidForArtist(
                releaseGroupMbid,
                artistNumericId,
                { attempts: 8, delayMs: 1500 },
              )) ||
              (await lidarr
                .getAlbumByMbid(releaseGroupMbid)
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
        lidarrAlbum = await lidarr
          .getAlbum(lidarrAlbum.id)
          .catch(() => lidarrAlbum);
      }
      const updatedArtist = await lidarr.getArtist(artistId);
      return this.mapLidarrAlbum(lidarrAlbum, updatedArtist);
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to add album to Lidarr: ${error.message}`,
      );
      return { error: error.message };
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

    let artist = await this.getArtist(normalizedArtistMbid);
    let createdArtist = false;

    if (!artist) {
      if (!hasPermission(user, "addArtist")) {
        const error = new Error(
          "Permission required: addArtist to create the album artist",
        );
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
        resolvedArtistAddOptions,
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

    let existingAlbum = await lidarr.getAlbumByMbid(normalizedAlbumMbid);
    if (
      existingAlbum &&
      existingAlbum.artistId != null &&
      String(existingAlbum.artistId) !== String(artist.id)
    ) {
      const error = new Error(
        "Album already exists in Lidarr under a different artist",
      );
      error.statusCode = 409;
      throw error;
    }

    const settings = getSettings();
    const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
    const shouldTriggerSearch = triggerSearch === true || searchOnAdd;
    if (!existingAlbum && createdArtist) {
      existingAlbum = await this.waitForAlbumByMbidForArtist(
        normalizedAlbumMbid,
        artist.id,
      );
    }
    const album = await this.addAlbum(
      artist.id,
      normalizedAlbumMbid,
      normalizedAlbumName,
      {
        triggerSearch: shouldTriggerSearch,
      },
    );

    if (album?.error) {
      const error = new Error(album.error);
      error.statusCode = 503;
      throw error;
    }

    const albumStatus =
      (album.statistics?.percentOfTracks ?? 0) >= 100 ||
      (album.statistics?.sizeOnDisk ?? 0) > 0
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

  async getAlbums(artistId, lidarrArtist = null) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return [];
    }
    try {
      const resolvedArtist =
        lidarrArtist || (await lidarr.getArtist(artistId));
      if (!resolvedArtist) {
        return [];
      }
      const allAlbums = await lidarr.request(
        `/album?artistId=${encodeURIComponent(artistId)}`,
      );
      const artistAlbums = Array.isArray(allAlbums)
        ? allAlbums.filter((a) => a.artistId === parseInt(artistId))
        : [];
      return artistAlbums.map((a) => this.mapLidarrAlbum(a, resolvedArtist));
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to fetch albums from Lidarr: ${error.message}`,
      );
      return [];
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
        return this.mapLidarrAlbum(updated, lidarrArtist);
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
        console.error(
          `[LibraryManager] Failed to update album in Lidarr: ${error.message}`,
        );
        return { error: error.message };
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
      return { success: true };
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to delete album from Lidarr: ${error.message}`,
      );
      return { success: false, error: error.message };
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
      } else if (
        lidarrAlbum.albumReleases &&
        lidarrAlbum.albumReleases.length > 0
      ) {
        for (const release of lidarrAlbum.albumReleases) {
          if (
            release.tracks &&
            Array.isArray(release.tracks) &&
            release.tracks.length > 0
          ) {
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
      if (error.message && error.message.includes("404")) {
        return [];
      }
      console.error(
        `[LibraryManager] Failed to fetch tracks from Lidarr: ${error.message}`,
      );
      return [];
    }
  }

  async getPlaybackQueue() {
    if (
      _playbackQueueCache &&
      _playbackQueueCache.expires > Date.now() &&
      _playbackQueueCache.tracks.length > 0
    ) {
      return _playbackQueueCache.tracks;
    }

    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return [];
    }

    try {
      const [artists, rawAlbums, rawTracks, rawTrackFiles] = await Promise.all([
        this.getAllArtists(),
        lidarr.request("/album"),
        lidarr.getAllTracks(),
        lidarr.getAllTrackFiles(),
      ]);

      const queue = buildPlaybackQueueFromLidarrData({
        artists,
        rawAlbums,
        rawTracks,
        rawTrackFiles,
      });

      if (queue.length > 0) {
        _playbackQueueCache = {
          tracks: queue,
          expires: Date.now() + PLAYBACK_QUEUE_CACHE_TTL_MS,
        };
      }
      return queue;
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to build playback queue: ${error.message}`,
      );
      return _playbackQueueCache?.tracks || [];
    }
  }

  mapLidarrTrack(
    lidarrTrack,
    lidarrAlbum,
    trackNumber = 0,
    albumIsComplete = false,
  ) {
    const trackFile = lidarrTrack.trackFile || lidarrTrack.file || null;
    const filePath =
      lidarrTrack.path ||
      trackFile?.path ||
      (trackFile?.relativePath && lidarrAlbum.path
        ? path.join(lidarrAlbum.path, trackFile.relativePath)
        : null) ||
      null;
    const size =
      lidarrTrack.sizeOnDisk ||
      lidarrTrack.size ||
      trackFile?.size ||
      trackFile?.sizeOnDisk ||
      0;
    return {
      id:
        lidarrTrack.id?.toString() ||
        lidarrTrack.foreignRecordingId ||
        `${lidarrAlbum.id}-${trackNumber}`,
      albumId: lidarrAlbum.id?.toString(),
      artistId:
        lidarrAlbum.artistId?.toString() || lidarrAlbum.artist?.id?.toString(),
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

  async scanLibrary(discover = false) {
    const { fileScanner } = await import("./fileScanner.js");
    return await fileScanner.scanLibrary(discover);
  }

  async updateAlbumStatistics(albumId) {
    const album = await this.getAlbumById(albumId);
    if (!album) return album;

    return album;
  }

  async updateArtistStatistics(artistId) {
    const artist = await this.getArtistById(artistId);
    if (!artist) return artist;

    return artist;
  }

  sanitizePath(name) {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export const libraryManager = new LibraryManager();
