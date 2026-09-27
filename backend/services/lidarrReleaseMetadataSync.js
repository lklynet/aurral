import { db } from "../config/db-sqlite.js";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  withLibraryChangeBatch,
} from "./libraryMediaStore.js";
import {
  getLibraryManagementEntry,
  setLibraryManagement,
} from "./libraryManagementStore.js";
import { invalidateCanonicalLibraryCache } from "./libraryQueryService.js";
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
  getSystemTaskQueue,
  getSystemTaskQueueName,
} from "./honkerDb.js";
import { lidarrClient } from "./lidarrClient.js";
import { logger } from "./logger.js";

const TASK_KIND = "lidarr-release-refresh";
const text = (value) => String(value || "").trim();
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text(value),
  );

function normalizeCatalogList(value, label) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  throw new Error(`Lidarr returned a malformed ${label} catalogue`);
}

function validateCatalogEntries(entries, label, requiredFields) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Lidarr returned a malformed ${label} catalogue entry at index ${index}`);
    }
    for (const requirement of requiredFields) {
      const fields = Array.isArray(requirement) ? requirement : [requirement];
      if (fields.every((field) => entry[field] == null || text(entry[field]) === "")) {
        throw new Error(
          `Lidarr returned a malformed ${label} catalogue entry at index ${index}: missing ${fields.join("/")}`,
        );
      }
    }
  }
}

function ensureLidarrManagement(entityKind, entityId, monitorMode = null) {
  if (getLibraryManagementEntry(entityKind, entityId)) return;
  setLibraryManagement({
    entityKind,
    entityId,
    managedBy: "lidarr",
    monitorMode,
  });
}

const lidarrCatalogStatements = {
  artist: {
    select: db.prepare(`
      SELECT entity.id, entity.identity_key, entity.metadata_json
      FROM library_artists AS entity
      JOIN library_management AS management
        ON management.entity_kind = 'artist'
        AND management.entity_id = entity.id
        AND management.managed_by = 'lidarr'
    `),
    update: db.prepare(`
      UPDATE library_artists
      SET metadata_json = ?, updated_at = ?
      WHERE id = ?
    `),
  },
  album: {
    select: db.prepare(`
      SELECT entity.id, entity.identity_key, entity.metadata_json
      FROM library_albums AS entity
      JOIN library_management AS management
        ON management.entity_kind = 'album'
        AND management.entity_id = entity.id
        AND management.managed_by = 'lidarr'
    `),
    update: db.prepare(`
      UPDATE library_albums
      SET metadata_json = ?, updated_at = ?
      WHERE id = ?
    `),
  },
};

function markUnseenCatalogEntries(entityKind, seenIdentityKeys) {
  const statements = lidarrCatalogStatements[entityKind];
  if (!statements) return 0;
  const rows = statements.select.all();
  let stale = 0;
  for (const row of rows) {
    if (seenIdentityKeys.has(row.identity_key)) continue;
    let metadata = {};
    try {
      const parsed = JSON.parse(row.metadata_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {}
    if (metadata.lidarrCatalogPresent === false) {
      continue;
    }
    statements.update.run(
      JSON.stringify({ ...metadata, lidarrCatalogPresent: false }),
      Date.now(),
      row.id,
    );
    stale += 1;
  }
  return stale;
}

export function scheduleLidarrReleaseMetadataRefresh({ delaySeconds = 0 } = {}) {
  const normalizedDelay = Math.max(0, Number(delaySeconds) || 0);
  const requestedRunAt = Math.floor(Date.now() / 1000) + normalizedDelay;
  const queueName = getSystemTaskQueueName(TASK_KIND);
  const existing = findActiveHonkerJob(
    queueName,
    (payload) => payload?.kind === TASK_KIND,
    { recoverExpired: true, payloadKind: TASK_KIND },
  );
  if (existing?.id) {
    const existingRunAt = Number(existing.run_at || 0);
    if (
      existing.state === "processing" ||
      existingRunAt === 0 ||
      existingRunAt <= requestedRunAt
    ) {
      return existing.id;
    }
    if (!getSystemTaskQueue().cancel(existing.id)) return existing.id;
  }
  return enqueueSystemTaskJob(
    { kind: TASK_KIND },
    { delaySeconds: normalizedDelay, priority: -5 },
  );
}

export async function refreshLidarrReleaseMetadata({
  client = lidarrClient,
  forceRefresh = true,
} = {}) {
  if (
    !client ||
    typeof client.isConfigured !== "function" ||
    !client.isConfigured() ||
    (typeof client.isEnabled === "function" && !client.isEnabled())
  ) {
    return {
      skipped: true,
      artistsSeen: 0,
      albumsSeen: 0,
      albumsSkipped: 0,
      artistsStale: 0,
      albumsStale: 0,
    };
  }

  const [artistResponse, albumResponse] = await Promise.all([
    client.request("/artist", "GET", null, false, { forceRefresh }),
    client.request("/album", "GET", null, false, { forceRefresh }),
  ]);
  const artists = normalizeCatalogList(artistResponse, "artist");
  const albums = normalizeCatalogList(albumResponse, "album");
  validateCatalogEntries(artists, "artist", ["id", ["artistName", "name"]]);
  validateCatalogEntries(albums, "album", ["id", "artistId", "title"]);
  const artistsByProviderId = new Map(
    artists
      .filter((artist) => artist?.id != null)
      .map((artist) => [String(artist.id), artist]),
  );
  if (artistsByProviderId.size === 0 && albums.length > 0) {
    throw new Error("Lidarr returned albums without an artist catalogue");
  }
  const seenArtistIdentityKeys = new Set();
  const seenAlbumIdentityKeys = new Set();
  let albumsSeen = 0;
  let albumsSkipped = 0;

  await withLibraryChangeBatch(async () => {
    const artistRecords = new Map();
    let processedArtists = 0;
    for (const artist of artistsByProviderId.values()) {
      const providerId = text(artist.foreignArtistId);
      const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
      const fallbackIdentityKey = buildFallbackIdentityKey(
        "lidarr-artist",
        artist.id,
        artistName,
      );
      const identityKey =
        (providerId && buildIdentityKey(isUuid(providerId) ? "mbid" : "lidarr-artist", providerId)) ||
        fallbackIdentityKey;
      const record = upsertLibraryArtist({
        identityKey,
        fallbackIdentityKey,
        fallbackMetadataId: artist.id,
        mbid: isUuid(providerId) ? providerId : null,
        name: artistName,
        sortName: artist.sortName || null,
        metadata: {
          ...artist,
          librarySource: "lidarr",
          lidarrCatalogPresent: true,
        },
        metadataOwner: "lidarr",
      });
      seenArtistIdentityKeys.add(record.identity_key);
      artistRecords.set(String(artist.id), record);
      ensureLidarrManagement(
        "artist",
        record.id,
        artist.monitor || artist.addOptions?.monitor || null,
      );
      processedArtists += 1;
      if (processedArtists % 100 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    let processedAlbums = 0;
    for (const album of albums) {
      processedAlbums += 1;
      const artist = artistsByProviderId.get(String(album?.artistId));
      const artistRecord = artistRecords.get(String(album?.artistId));
      if (!artist || !artistRecord || album?.id == null) {
        albumsSkipped += 1;
        if (processedAlbums % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        continue;
      }
      const providerId = text(album.foreignAlbumId);
      const fallbackIdentityKey = buildFallbackIdentityKey(
        "lidarr-album",
        album.id,
        album.title,
      );
      const identityKey =
        (providerId &&
          buildIdentityKey(isUuid(providerId) ? "release-group" : "lidarr-album", providerId)) ||
        fallbackIdentityKey;
      const record = upsertLibraryAlbum({
        identityKey,
        fallbackIdentityKey,
        fallbackMetadataId: album.id,
        mbid: isUuid(providerId) ? providerId : null,
        releaseGroupMbid: isUuid(providerId) ? providerId : null,
        artistId: artistRecord.id,
        title: text(album.title) || "Unknown Album",
        albumArtist: text(artist.artistName || artist.name) || "Unknown Artist",
        releaseDate: album.releaseDate || null,
        replaceReleaseDate: true,
        metadata: {
          ...album,
          librarySource: "lidarr",
          lidarrCatalogPresent: true,
        },
        metadataOwner: "lidarr",
      });
      seenAlbumIdentityKeys.add(record.identity_key);
      ensureLidarrManagement(
        "album",
        record.id,
        album.monitor || album.addOptions?.monitor || null,
      );
      albumsSeen += 1;
      if (processedAlbums % 100 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  });

  let artistsStale = 0;
  let albumsStale = 0;
  if (albumsSkipped === 0) {
    artistsStale = markUnseenCatalogEntries("artist", seenArtistIdentityKeys);
    albumsStale = markUnseenCatalogEntries("album", seenAlbumIdentityKeys);
    if (artistsStale > 0 || albumsStale > 0) {
      invalidateCanonicalLibraryCache({ persistedGenres: false });
    }
  }

  logger.info("library", "Lidarr release metadata refreshed", {
    artists: artistsByProviderId.size,
    albums: albumsSeen,
    skippedAlbums: albumsSkipped,
    staleArtists: artistsStale,
    staleAlbums: albumsStale,
  });
  return {
    skipped: false,
    artistsSeen: artistsByProviderId.size,
    albumsSeen,
    albumsSkipped,
    artistsStale,
    albumsStale,
  };
}
