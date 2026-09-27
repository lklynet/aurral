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
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
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

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  return [];
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

export function scheduleLidarrReleaseMetadataRefresh({ delaySeconds = 0 } = {}) {
  const queueName = getSystemTaskQueueName(TASK_KIND);
  const existing = findActiveHonkerJob(
    queueName,
    (payload) => payload?.kind === TASK_KIND,
    { recoverExpired: true, payloadKind: TASK_KIND },
  );
  if (existing?.id) return existing.id;
  return enqueueSystemTaskJob(
    { kind: TASK_KIND },
    { delaySeconds: Math.max(0, Number(delaySeconds) || 0), priority: -5 },
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
    return { skipped: true, artistsSeen: 0, albumsSeen: 0, albumsSkipped: 0 };
  }

  const [artistResponse, albumResponse] = await Promise.all([
    client.request("/artist", "GET", null, false, { forceRefresh }),
    client.getAllAlbums({ forceRefresh }),
  ]);
  const artists = normalizeList(artistResponse);
  const albums = normalizeList(albumResponse);
  const artistsByProviderId = new Map(
    artists
      .filter((artist) => artist?.id != null)
      .map((artist) => [String(artist.id), artist]),
  );
  let albumsSeen = 0;
  let albumsSkipped = 0;

  await withLibraryChangeBatch(async () => {
    const artistRecords = new Map();
    let processedArtists = 0;
    for (const artist of artistsByProviderId.values()) {
      const providerId = text(artist.foreignArtistId);
      const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
      const identityKey =
        (providerId && buildIdentityKey(isUuid(providerId) ? "mbid" : "lidarr-artist", providerId)) ||
        buildFallbackIdentityKey("lidarr-artist", artist.id, artistName);
      const record = upsertLibraryArtist({
        identityKey,
        mbid: isUuid(providerId) ? providerId : null,
        name: artistName,
        sortName: artist.sortName || null,
        metadata: { ...artist, librarySource: "lidarr" },
      });
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
      const identityKey =
        (providerId &&
          buildIdentityKey(isUuid(providerId) ? "release-group" : "lidarr-album", providerId)) ||
        buildFallbackIdentityKey("lidarr-album", album.id, album.title);
      const record = upsertLibraryAlbum({
        identityKey,
        mbid: isUuid(providerId) ? providerId : null,
        releaseGroupMbid: isUuid(providerId) ? providerId : null,
        artistId: artistRecord.id,
        title: text(album.title) || "Unknown Album",
        albumArtist: text(artist.artistName || artist.name) || "Unknown Artist",
        releaseDate: album.releaseDate || null,
        metadata: { ...album, librarySource: "lidarr" },
      });
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

  logger.info("library", "Lidarr release metadata refreshed", {
    artists: artistsByProviderId.size,
    albums: albumsSeen,
    skippedAlbums: albumsSkipped,
  });
  return {
    skipped: false,
    artistsSeen: artistsByProviderId.size,
    albumsSeen,
    albumsSkipped,
  };
}
