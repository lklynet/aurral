import fs from "fs/promises";
import path from "path";
import { dbOps } from "../config/db-helpers.js";
import { dbHelpers, db } from "../config/db-sqlite.js";
import {
  musicbrainzRequest,
  musicbrainzGetArtistReleaseGroups,
} from "./apiClients.js";
import { websocketService } from "./websocketService.js";

const LIDARR_RETRY_MS = 60000;
const TRACKS_CACHE_TTL_MS = 120000;
const TRACKS_CACHE_MAX = 300;
const ACTIVITY_POLL_INTERVAL_MS = 60000;
const COMMANDS_CACHE_MS = 60000;
const SIGNALR_ACTIVITY_POLL_MS = 300000;

let lidarrClient = null;
let _cachedArtists = [];
let _cachedAlbums = [];
let _cachedQueue = null;
let _cachedHistory = null;
let _cachedCommands = null;
let _lastCommandsAt = 0;
let _lastLidarrFailureAt = 0;
let _retryTimeoutId = null;
let _activityPollIntervalId = null;
let _lastQueueSignature = null;
let _lastHistorySignature = null;
let _lastSignalrActivityAt = 0;
const _tracksCache = new Map();

const selectAllArtistsStmt = db.prepare(
  "SELECT data FROM lidarr_artists ORDER BY artist_name COLLATE NOCASE",
);
const selectArtistByMbidStmt = db.prepare(
  "SELECT data FROM lidarr_artists WHERE foreign_artist_id = ? LIMIT 1",
);
const selectArtistByIdStmt = db.prepare(
  "SELECT data FROM lidarr_artists WHERE id = ? LIMIT 1",
);
const upsertArtistStmt = db.prepare(`
  INSERT INTO lidarr_artists (id, foreign_artist_id, artist_name, data, updated_at)
  VALUES (@id, @foreignArtistId, @artistName, @data, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    foreign_artist_id = excluded.foreign_artist_id,
    artist_name = excluded.artist_name,
    data = excluded.data,
    updated_at = excluded.updated_at
`);
const deleteArtistByIdStmt = db.prepare(
  "DELETE FROM lidarr_artists WHERE id = ?",
);
const deleteArtistByMbidStmt = db.prepare(
  "DELETE FROM lidarr_artists WHERE foreign_artist_id = ?",
);
const deleteAllArtistsStmt = db.prepare("DELETE FROM lidarr_artists");

const selectAllAlbumsStmt = db.prepare(
  "SELECT data FROM lidarr_albums ORDER BY album_name COLLATE NOCASE",
);
const selectAlbumsByArtistIdStmt = db.prepare(
  "SELECT data FROM lidarr_albums WHERE artist_id = ? ORDER BY album_name COLLATE NOCASE",
);
const selectAlbumByIdStmt = db.prepare(
  "SELECT data FROM lidarr_albums WHERE id = ? LIMIT 1",
);
const selectAlbumByMbidStmt = db.prepare(
  "SELECT data FROM lidarr_albums WHERE foreign_album_id = ? LIMIT 1",
);
const upsertAlbumStmt = db.prepare(`
  INSERT INTO lidarr_albums (id, artist_id, foreign_album_id, album_name, data, updated_at)
  VALUES (@id, @artistId, @foreignAlbumId, @albumName, @data, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    artist_id = excluded.artist_id,
    foreign_album_id = excluded.foreign_album_id,
    album_name = excluded.album_name,
    data = excluded.data,
    updated_at = excluded.updated_at
`);
const deleteAlbumByIdStmt = db.prepare(
  "DELETE FROM lidarr_albums WHERE id = ?",
);
const deleteAlbumsByArtistIdStmt = db.prepare(
  "DELETE FROM lidarr_albums WHERE artist_id = ?",
);
const deleteAllAlbumsStmt = db.prepare("DELETE FROM lidarr_albums");

const selectTracksByAlbumIdStmt = db.prepare(
  "SELECT data FROM lidarr_tracks WHERE album_id = ? ORDER BY track_number ASC, track_name COLLATE NOCASE",
);
const upsertTrackStmt = db.prepare(`
  INSERT INTO lidarr_tracks (id, album_id, artist_id, foreign_track_id, track_name, track_number, data, updated_at)
  VALUES (@id, @albumId, @artistId, @foreignTrackId, @trackName, @trackNumber, @data, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    album_id = excluded.album_id,
    artist_id = excluded.artist_id,
    foreign_track_id = excluded.foreign_track_id,
    track_name = excluded.track_name,
    track_number = excluded.track_number,
    data = excluded.data,
    updated_at = excluded.updated_at
`);
const deleteTracksByAlbumIdStmt = db.prepare(
  "DELETE FROM lidarr_tracks WHERE album_id = ?",
);
const deleteTracksByArtistIdStmt = db.prepare(
  "DELETE FROM lidarr_tracks WHERE artist_id = ?",
);
const deleteTrackByIdStmt = db.prepare(
  "DELETE FROM lidarr_tracks WHERE id = ?",
);

const selectSyncMetaStmt = db.prepare(
  "SELECT value FROM lidarr_sync_meta WHERE key = ?",
);
const upsertSyncMetaStmt = db.prepare(`
  INSERT INTO lidarr_sync_meta (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function safeStringify(data) {
  try {
    return JSON.stringify(data ?? {});
  } catch {
    return "{}";
  }
}

function parseRowData(row) {
  if (!row) return null;
  return dbHelpers.parseJSON(row.data) || null;
}

function loadCachedArtists() {
  const rows = selectAllArtistsStmt.all();
  return rows.map(parseRowData).filter(Boolean);
}

function loadCachedAlbums() {
  const rows = selectAllAlbumsStmt.all();
  return rows.map(parseRowData).filter(Boolean);
}

function loadCachedArtistByMbid(mbid) {
  return parseRowData(selectArtistByMbidStmt.get(mbid));
}

function loadCachedArtistById(id) {
  return parseRowData(selectArtistByIdStmt.get(id));
}

function loadCachedAlbumsByArtistId(artistId) {
  const rows = selectAlbumsByArtistIdStmt.all(String(artistId));
  return rows.map(parseRowData).filter(Boolean);
}

function loadCachedAlbumById(id) {
  return parseRowData(selectAlbumByIdStmt.get(String(id)));
}

function loadCachedAlbumByMbid(mbid) {
  return parseRowData(selectAlbumByMbidStmt.get(mbid));
}

function loadCachedTracksByAlbumId(albumId) {
  const rows = selectTracksByAlbumIdStmt.all(String(albumId));
  return rows.map(parseRowData).filter(Boolean);
}

function upsertArtistCache(artist) {
  if (!artist) return;
  _cachedArtists = [];
  const payload = {
    id: String(artist.id ?? ""),
    foreignArtistId: artist.foreignArtistId || artist.mbid || null,
    artistName: artist.artistName || artist.name || "",
    data: safeStringify(artist),
    updatedAt: Date.now(),
  };
  if (!payload.id) return;
  upsertArtistStmt.run(payload);
}

function upsertAlbumCache(album) {
  if (!album) return;
  _cachedAlbums = [];
  const payload = {
    id: String(album.id ?? ""),
    artistId: String(album.artistId ?? ""),
    foreignAlbumId: album.foreignAlbumId || album.mbid || null,
    albumName: album.albumName || album.title || "",
    data: safeStringify(album),
    updatedAt: Date.now(),
  };
  if (!payload.id) return;
  upsertAlbumStmt.run(payload);
}

function upsertTrackCache(track) {
  if (!track) return;
  _tracksCache.delete(String(track.albumId));
  const payload = {
    id: String(track.id ?? ""),
    albumId: String(track.albumId ?? ""),
    artistId: String(track.artistId ?? ""),
    foreignTrackId: track.foreignTrackId || track.mbid || null,
    trackName: track.trackName || track.title || "",
    trackNumber: track.trackNumber || 0,
    data: safeStringify(track),
    updatedAt: Date.now(),
  };
  if (!payload.id) return;
  upsertTrackStmt.run(payload);
}

const replaceAllArtistsTx = db.transaction((artists) => {
  deleteAllArtistsStmt.run();
  for (const artist of artists) {
    upsertArtistCache(artist);
  }
  _cachedArtists = artists;
});

const replaceAllAlbumsTx = db.transaction((albums) => {
  deleteAllAlbumsStmt.run();
  for (const album of albums) {
    upsertAlbumCache(album);
  }
  _cachedAlbums = albums;
});

const replaceTracksByAlbumTx = db.transaction((albumId, tracks) => {
  deleteTracksByAlbumIdStmt.run(String(albumId));
  for (const track of tracks) {
    upsertTrackCache(track);
  }
});

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

export class LibraryManager {
  async addArtist(mbid, artistName, options = {}) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { error: "Lidarr is not configured" };
    }
    try {
      const existing = await lidarr.getArtistByMbid(mbid);
      if (existing) {
        const mapped = this.mapLidarrArtist(existing);
        upsertArtistCache(mapped);
        return mapped;
      }
      const lidarrSettings = getSettings();
      const lidarrArtist = await lidarr.addArtist(mbid, artistName, {
        albumOnly: options.albumOnly === true,
        monitorOption: options.monitorOption || "none",
        qualityProfileId: lidarrSettings.integrations?.lidarr?.qualityProfileId,
        metadataProfileId:
          lidarrSettings.integrations?.lidarr?.metadataProfileId,
      });
      console.log(`[LibraryManager] Added artist "${artistName}" to Lidarr`);
      const mapped = this.mapLidarrArtist(lidarrArtist);
      upsertArtistCache(mapped);
      return mapped;
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to add artist to Lidarr: ${error.message}`,
      );
      return { error: error.message };
    }
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
    const cached = loadCachedArtistByMbid(mbid);
    if (cached) return cached;
    if (!lidarr || !lidarr.isConfigured()) return null;
    try {
      const lidarrArtist = await lidarr.getArtistByMbid(mbid);
      if (!lidarrArtist) return null;
      const mapped = this.mapLidarrArtist(lidarrArtist);
      upsertArtistCache(mapped);
      return mapped;
    } catch {
      return null;
    }
  }

  async getArtistById(id) {
    const lidarr = await getLidarrClient();
    const cached = loadCachedArtistById(id);
    if (cached) return cached;
    if (!lidarr || !lidarr.isConfigured()) return null;
    try {
      const lidarrArtist = await lidarr.getArtist(id);
      const mapped = this.mapLidarrArtist(lidarrArtist);
      upsertArtistCache(mapped);
      return mapped;
    } catch (error) {
      return null;
    }
  }

  async getAllArtists() {
    try {
      if (_cachedArtists.length > 0) return _cachedArtists;

      const lidarr = await getLidarrClient();
      const cachedFromDb = loadCachedArtists();
      if (cachedFromDb.length > 0) {
        _cachedArtists = cachedFromDb;
        return cachedFromDb;
      }
      if (!lidarr || !lidarr.isConfigured()) return _cachedArtists;
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
        replaceAllArtistsTx(_cachedArtists);
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

  async getAllAlbums() {
    try {
      if (_cachedAlbums.length > 0) return _cachedAlbums;

      const cached = loadCachedAlbums();
      if (cached.length > 0) {
        _cachedAlbums = cached;
        return cached;
      }

      // If cache is empty, trigger a full sync to populate it
      const result = await this.fullSyncFromLidarr();
      if (result.success) {
        const fresh = loadCachedAlbums();
        _cachedAlbums = fresh;
        return fresh;
      }
      return [];
    } catch (err) {
      console.warn("[LibraryManager] Failed to get all albums:", err.message);
      return [];
    }
  }

  mapLidarrArtist(lidarrArtist) {
    const artistPath = lidarrArtist.path ?? null;
    const monitorOption =
      lidarrArtist.monitor || lidarrArtist.addOptions?.monitor || "none";
    const normalizedMonitorOption =
      monitorOption === "existing" ? "all" : monitorOption;
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
        const normalizedMonitorOption =
          monitorOption === "existing" ? "all" : monitorOption;
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
        upsertArtistCache(mapped);
        return mapped;
      }
      const mapped = this.mapLidarrArtist(lidarrArtist);
      upsertArtistCache(mapped);
      return mapped;
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
      console.log(
        `[LibraryManager] Deleted artist "${lidarrArtist.artistName}" from Lidarr`,
      );
      deleteArtistByIdStmt.run(String(lidarrArtist.id));
      deleteArtistByMbidStmt.run(mbid);
      deleteAlbumsByArtistIdStmt.run(String(lidarrArtist.id));
      deleteTracksByArtistIdStmt.run(String(lidarrArtist.id));
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
      let lidarrArtist = await lidarr.getArtist(artistId);
      if (!lidarrArtist) return { error: "Artist not found in Lidarr" };
      if (!lidarrArtist.monitored) {
        await lidarr.updateArtistMonitoring(artistId, "missing");
        lidarrArtist = await lidarr.getArtist(artistId);
      }
      const existing = await lidarr.getAlbumByMbid(releaseGroupMbid);
      if (existing) {
        const mapped = this.mapLidarrAlbum(existing, lidarrArtist);
        upsertAlbumCache(mapped);
        return mapped;
      }
      const settings = getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      const lidarrAlbum = await lidarr.addAlbum(
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
      const allAlbums = await lidarr.request(
        `/album?artistId=${encodeURIComponent(artistId)}`,
      );
      const artistAlbumIds = Array.isArray(allAlbums)
        ? allAlbums
            .filter(
              (a) =>
                a.artistId === parseInt(artistId) &&
                a.foreignAlbumId !== releaseGroupMbid,
            )
            .map((a) => a.id)
        : [];
      for (const albumId of artistAlbumIds) {
        try {
          await lidarr.updateAlbum(albumId, { monitored: false });
        } catch (err) {
          console.error(
            `[LibraryManager] Failed to unmonitor album ${albumId}:`,
            err.message,
          );
        }
      }
      const updatedArtist = await lidarr.getArtist(artistId);
      const mapped = this.mapLidarrAlbum(lidarrAlbum, updatedArtist);
      upsertAlbumCache(mapped);
      return mapped;
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to add album to Lidarr: ${error.message}`,
      );
      return { error: error.message };
    }
  }

  async getAlbums(artistId) {
    const lidarr = await getLidarrClient();
    const cached = loadCachedAlbumsByArtistId(artistId);
    if (cached.length > 0) return cached;
    if (!lidarr || !lidarr.isConfigured()) return [];
    try {
      const lidarrArtist = await lidarr.getArtist(artistId);
      if (!lidarrArtist) {
        return [];
      }
      const allAlbums = await lidarr.request(
        `/album?artistId=${encodeURIComponent(artistId)}`,
      );
      const artistAlbums = Array.isArray(allAlbums)
        ? allAlbums.filter((a) => a.artistId === parseInt(artistId))
        : [];
      const mapped = artistAlbums.map((a) =>
        this.mapLidarrAlbum(a, lidarrArtist),
      );
      for (const album of mapped) {
        upsertAlbumCache(album);
      }
      return mapped;
    } catch (error) {
      console.error(
        `[LibraryManager] Failed to fetch albums from Lidarr: ${error.message}`,
      );
      return [];
    }
  }

  async getAlbumById(id) {
    const lidarr = await getLidarrClient();
    const cached = loadCachedAlbumById(id);
    if (cached) return cached;
    if (!lidarr || !lidarr.isConfigured()) return null;
    if (!id || id === "undefined" || id === "null") {
      return null;
    }
    try {
      const lidarrAlbum = await lidarr.getAlbum(id);
      if (!lidarrAlbum) {
        return null;
      }
      const lidarrArtist = await lidarr.getArtist(lidarrAlbum.artistId);
      const mapped = this.mapLidarrAlbum(lidarrAlbum, lidarrArtist);
      upsertAlbumCache(mapped);
      return mapped;
    } catch (error) {
      if (error.response?.status === 404 || error.message?.includes("404")) {
        return null;
      }
      return null;
    }
  }

  async getAlbumByMbid(mbid) {
    const lidarr = await getLidarrClient();
    const cached = loadCachedAlbumByMbid(mbid);
    if (cached) return cached;
    if (!lidarr || !lidarr.isConfigured()) return null;
    try {
      const lidarrAlbum = await lidarr.getAlbumByMbid(mbid);
      if (!lidarrAlbum) return null;
      const lidarrArtist = await lidarr.getArtist(lidarrAlbum.artistId);
      const mapped = this.mapLidarrAlbum(lidarrAlbum, lidarrArtist);
      upsertAlbumCache(mapped);
      return mapped;
    } catch {
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
        percentOfTracks = percentOfTracks;
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
        upsertAlbumCache(mapped);
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
      deleteAlbumByIdStmt.run(String(id));
      deleteTracksByAlbumIdStmt.run(String(id));
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
    const cachedFromDb = loadCachedTracksByAlbumId(albumId);
    if (cachedFromDb.length > 0) {
      _tracksCache.set(key, {
        tracks: cachedFromDb,
        expires: Date.now() + TRACKS_CACHE_TTL_MS,
      });
      return cachedFromDb;
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
        normalizedPercent = rawPercent;
      } else if (rawPercent <= 1 && rawPercent >= 0) {
        normalizedPercent = Math.round(rawPercent * 100);
      } else if (rawPercent > 100) {
        normalizedPercent = Math.min(100, Math.round(rawPercent / 10));
      }

      const isAlbumComplete = normalizedPercent >= 100 || albumSizeOnDisk > 0;

      let result = [];

      if (
        lidarrAlbum.tracks &&
        Array.isArray(lidarrAlbum.tracks) &&
        lidarrAlbum.tracks.length > 0
      ) {
        result = lidarrAlbum.tracks.map((t, index) =>
          this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
        );
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
            result = release.tracks.map((t, index) =>
              this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
            );
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
          result = allTracks.map((t, index) =>
            this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
          );
        }
      }

      if (result.length === 0) {
        const lidarrTracks = await lidarr.getTracksByAlbumId(albumId);
        if (lidarrTracks && lidarrTracks.length > 0) {
          result = lidarrTracks.map((t, index) =>
            this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
          );
        }
      }

      if (_tracksCache.size >= TRACKS_CACHE_MAX) {
        const firstKey = _tracksCache.keys().next().value;
        if (firstKey !== undefined) _tracksCache.delete(firstKey);
      }
      replaceTracksByAlbumTx(albumId, result);
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

  mapLidarrTrack(
    lidarrTrack,
    lidarrAlbum,
    trackNumber = 0,
    albumIsComplete = false,
  ) {
    const path = lidarrTrack.path || null;
    const size = lidarrTrack.sizeOnDisk || lidarrTrack.size || 0;
    const hasFileExplicit = lidarrTrack.hasFile;
    const hasFileFromPathOrSize = !!(path || size > 0);
    const albumSizeOnDisk = lidarrAlbum.statistics?.sizeOnDisk || 0;

    let hasFile = false;

    if (albumIsComplete || albumSizeOnDisk > 0) {
      hasFile = true;
    } else if (hasFileExplicit === true) {
      hasFile = true;
    } else if (hasFileFromPathOrSize) {
      hasFile = true;
    } else if (hasFileExplicit === false) {
      hasFile = false;
    }

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
      path: path,
      hasFile: hasFile,
      size: size,
      quality:
        lidarrTrack.mediaInfo?.audioFormat ||
        lidarrTrack.quality?.quality?.name ||
        null,
      addedAt: lidarrTrack.added || new Date().toISOString(),
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
      const updated = { ...track, ...updates };
      upsertTrackCache(updated);
      return updated;
    } catch {
      return null;
    }
  }

  removeArtistCacheById(id) {
    if (!id) return;
    deleteArtistByIdStmt.run(String(id));
    deleteAlbumsByArtistIdStmt.run(String(id));
    deleteTracksByArtistIdStmt.run(String(id));
  }

  removeArtistCacheByMbid(mbid) {
    if (!mbid) return;
    const cached = loadCachedArtistByMbid(mbid);
    deleteArtistByMbidStmt.run(String(mbid));
    if (cached?.id) {
      deleteAlbumsByArtistIdStmt.run(String(cached.id));
      deleteTracksByArtistIdStmt.run(String(cached.id));
    }
  }

  removeAlbumCacheById(id) {
    if (!id) return;
    deleteAlbumByIdStmt.run(String(id));
    deleteTracksByAlbumIdStmt.run(String(id));
  }

  removeAlbumCacheByMbid(mbid) {
    if (!mbid) return;
    const cached = loadCachedAlbumByMbid(mbid);
    if (cached?.id) {
      deleteAlbumByIdStmt.run(String(cached.id));
      deleteTracksByAlbumIdStmt.run(String(cached.id));
    }
  }

  getLastFullSyncAt() {
    const row = selectSyncMetaStmt.get("last_full_sync_at");
    if (!row?.value) return null;
    const parsed = Number(row.value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  setLastFullSyncAt(timestamp) {
    if (!timestamp) return;
    upsertSyncMetaStmt.run("last_full_sync_at", String(timestamp));
  }

  async fullSyncFromLidarr() {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) {
      return { success: false, error: "Lidarr is not configured" };
    }
    try {
      const [artists, albums] = await Promise.all([
        lidarr.getAllArtists(),
        lidarr.getAllAlbums(),
      ]);

      if (Array.isArray(artists)) {
        _cachedArtists = artists.map((a) => this.mapLidarrArtist(a));
        replaceAllArtistsTx(_cachedArtists);
      }
      if (Array.isArray(albums)) {
        // Map albums with artist info if possible, but mapLidarrAlbum handles missing artist
        // We need to match albums to artists to get artistName
        const artistMap = new Map(_cachedArtists.map((a) => [a.id, a]));
        const mappedAlbums = albums.map((album) => {
          const artist = artistMap.get(String(album.artistId));
          return this.mapLidarrAlbum(album, artist);
        });
        replaceAllAlbumsTx(mappedAlbums);
      }

      this.setLastFullSyncAt(Date.now());
      return {
        success: true,
        artists: artists.length,
        albums: albums.length,
      };
    } catch (error) {
      console.error(`[LibraryManager] Full sync failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async refreshActivity() {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return;
    try {
      const [queue, history] = await Promise.all([
        lidarr.getQueue().catch(() => []),
        lidarr.getHistory(1, 200).catch(() => ({ records: [] })),
      ]);

      const nextQueue = Array.isArray(queue) ? queue : queue?.records || [];
      const nextHistory = history || { records: [] };
      const historyRecords = Array.isArray(nextHistory)
        ? nextHistory
        : nextHistory?.records || [];

      const queueSignature = nextQueue
        .map((item) =>
          [
            item?.id ?? item?.downloadId ?? "",
            item?.status ?? "",
            item?.trackedDownloadState ?? "",
            item?.trackedDownloadStatus ?? "",
            item?.size ?? "",
            item?.sizeleft ?? "",
          ].join("|"),
        )
        .sort()
        .join("||");
      const historySignature = historyRecords
        .map((item) =>
          [
            item?.id ?? "",
            item?.eventType ?? "",
            item?.date ?? item?.eventDate ?? "",
          ].join("|"),
        )
        .sort()
        .join("||");

      _cachedQueue = nextQueue;
      _cachedHistory = nextHistory;

      if (
        queueSignature !== _lastQueueSignature ||
        historySignature !== _lastHistorySignature
      ) {
        _lastQueueSignature = queueSignature;
        _lastHistorySignature = historySignature;
        websocketService.emitQueueUpdate({
          queueCount: nextQueue.length,
          historyCount: historyRecords.length,
        });
      }
    } catch (error) {}
  }

  async refreshActivityFromSignalR() {
    _lastSignalrActivityAt = Date.now();
    await this.refreshActivity();
  }

  async refreshActivityIfNeeded() {
    let signalrConnected = false;
    try {
      const { lidarrSignalRService } = await import("./lidarrClient.js");
      signalrConnected = !!lidarrSignalRService?.isConnected?.();
    } catch {}
    if (signalrConnected) {
      const now = Date.now();
      if (_lastSignalrActivityAt && now - _lastSignalrActivityAt < SIGNALR_ACTIVITY_POLL_MS) {
        return;
      }
      _lastSignalrActivityAt = now;
    }
    await this.refreshActivity();
  }

  startActivityPolling() {
    if (_activityPollIntervalId) return;
    this.refreshActivity(); // Initial fetch
    _activityPollIntervalId = setInterval(() => {
      this.refreshActivityIfNeeded();
    }, ACTIVITY_POLL_INTERVAL_MS);
    console.log("[LibraryManager] Started background activity polling");
  }

  stopActivityPolling() {
    if (_activityPollIntervalId) {
      clearInterval(_activityPollIntervalId);
      _activityPollIntervalId = null;
    }
  }

  async getQueue() {
    if (_cachedQueue === null) {
      await this.refreshActivity();
    }
    return _cachedQueue || [];
  }

  async getHistory() {
    if (_cachedHistory === null) {
      await this.refreshActivity();
    }
    return _cachedHistory || { records: [] };
  }

  async refreshCommands(force = false) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return;
    const now = Date.now();
    if (
      !force &&
      _cachedCommands &&
      now - _lastCommandsAt < COMMANDS_CACHE_MS
    ) {
      return;
    }
    try {
      const commands = await lidarr.request("/command").catch(() => []);
      _cachedCommands = Array.isArray(commands)
        ? commands
        : commands?.records || [];
      _lastCommandsAt = now;
    } catch (error) {}
  }

  updateCommandCacheFromSignalR(payload) {
    if (!payload) return;
    const command =
      payload?.resource || payload?.data || payload?.item || payload;
    if (!command) return;
    const commandId = command?.id ?? command?.commandId ?? null;
    if (_cachedCommands === null) {
      _cachedCommands = [];
    }
    if (commandId != null) {
      const index = _cachedCommands.findIndex(
        (item) =>
          item?.id === commandId ||
          item?.commandId === commandId ||
          item?.id === String(commandId),
      );
      if (index >= 0) {
        _cachedCommands[index] = {
          ..._cachedCommands[index],
          ...command,
        };
      } else {
        _cachedCommands.unshift(command);
      }
    } else {
      _cachedCommands.unshift(command);
    }
    _lastCommandsAt = Date.now();
  }

  async getCommands({ force = false } = {}) {
    if (_cachedCommands === null) {
      await this.refreshCommands(true);
    } else if (force) {
      await this.refreshCommands(true);
    } else {
      await this.refreshCommands(false);
    }
    return _cachedCommands || [];
  }

  async syncArtistFromLidarr(idOrMbid) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return null;
    const value = String(idOrMbid || "").trim();
    if (!value) return null;
    try {
      const isMbid = value.includes("-") && value.length >= 32;
      const artist = isMbid
        ? await lidarr.getArtistByMbid(value)
        : await lidarr.getArtist(value);
      if (!artist) return null;
      const mapped = this.mapLidarrArtist(artist);
      upsertArtistCache(mapped);
      return mapped;
    } catch {
      return null;
    }
  }

  async syncAlbumFromLidarr(albumId) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return null;
    const value = String(albumId || "").trim();
    if (!value) return null;
    try {
      const album = await lidarr.getAlbum(value);
      if (!album) return null;
      const artist = await lidarr.getArtist(album.artistId);
      const mapped = this.mapLidarrAlbum(album, artist);
      upsertAlbumCache(mapped);
      return mapped;
    } catch {
      return null;
    }
  }

  async syncAlbumTracksFromLidarr(albumId) {
    const lidarr = await getLidarrClient();
    if (!lidarr || !lidarr.isConfigured()) return [];
    const value = String(albumId || "").trim();
    if (!value) return [];
    try {
      const lidarrAlbum = await lidarr.getAlbum(value);
      if (!lidarrAlbum) return [];
      const rawPercent = lidarrAlbum.statistics?.percentOfTracks || 0;
      const albumSizeOnDisk = lidarrAlbum.statistics?.sizeOnDisk || 0;
      let normalizedPercent = rawPercent;

      if (rawPercent > 1 && rawPercent <= 100) {
        normalizedPercent = rawPercent;
      } else if (rawPercent <= 1 && rawPercent >= 0) {
        normalizedPercent = Math.round(rawPercent * 100);
      } else if (rawPercent > 100) {
        normalizedPercent = Math.min(100, Math.round(rawPercent / 10));
      }

      const isAlbumComplete = normalizedPercent >= 100 || albumSizeOnDisk > 0;
      let result = [];

      if (
        lidarrAlbum.tracks &&
        Array.isArray(lidarrAlbum.tracks) &&
        lidarrAlbum.tracks.length > 0
      ) {
        result = lidarrAlbum.tracks.map((t, index) =>
          this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
        );
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
            result = release.tracks.map((t, index) =>
              this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
            );
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
          result = allTracks.map((t, index) =>
            this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
          );
        }
      }

      if (result.length === 0) {
        const lidarrTracks = await lidarr.getTracksByAlbumId(value);
        if (lidarrTracks && lidarrTracks.length > 0) {
          result = lidarrTracks.map((t, index) =>
            this.mapLidarrTrack(t, lidarrAlbum, index + 1, isAlbumComplete),
          );
        }
      }

      replaceTracksByAlbumTx(value, result);
      const key = String(value);
      if (_tracksCache.size >= TRACKS_CACHE_MAX) {
        const firstKey = _tracksCache.keys().next().value;
        if (firstKey !== undefined) _tracksCache.delete(firstKey);
      }
      _tracksCache.set(key, {
        tracks: result,
        expires: Date.now() + TRACKS_CACHE_TTL_MS,
      });
      return result;
    } catch {
      return [];
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
