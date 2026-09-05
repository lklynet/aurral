import fs from "fs/promises";
import path from "path";
import { db } from "../config/db-sqlite.js";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  getAvailableLibraryMediaPaths,
  getAvailableLibraryMediaPathsForArtists,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
import { slimLidarrAlbum, slimLidarrArtist, slimLidarrTrack } from "./libraryMetadataProjection.js";
import { mapWithConcurrency } from "./discovery/helpers.js";

const text = (value) => String(value || "").trim();

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text(value),
  );

function buildFileIndex(files) {
  const index = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (file?.id != null) index.set(`file:${file.id}`, file);
    for (const trackId of Array.isArray(file?.trackIds) ? file.trackIds : []) {
      index.set(`track:${trackId}`, file);
    }
  }
  return index;
}

function buildBulkAlbumTrackData(albums, tracks, files) {
  const tracksByAlbumId = new Map();
  const albumIdsByTrackId = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (track?.albumId == null) continue;
    const albumId = String(track.albumId);
    const albumTracks = tracksByAlbumId.get(albumId) || [];
    albumTracks.push(track);
    tracksByAlbumId.set(albumId, albumTracks);
    const trackAlbums = albumIdsByTrackId.get(String(track.id)) || new Set();
    trackAlbums.add(albumId);
    albumIdsByTrackId.set(String(track.id), trackAlbums);
  }

  const filesByAlbumId = new Map();
  const addFile = (albumId, file) => {
    const key = String(albumId);
    const albumFiles = filesByAlbumId.get(key) || new Map();
    const fileKey = file?.id != null ? `id:${file.id}` : `path:${file?.path || ""}`;
    albumFiles.set(fileKey, file);
    filesByAlbumId.set(key, albumFiles);
  };
  for (const file of Array.isArray(files) ? files : []) {
    const albumIds = new Set();
    if (file?.albumId != null) albumIds.add(String(file.albumId));
    for (const trackId of [file?.trackId, ...(Array.isArray(file?.trackIds) ? file.trackIds : [])]) {
      for (const albumId of albumIdsByTrackId.get(String(trackId)) || []) albumIds.add(albumId);
    }
    for (const albumId of albumIds) addFile(albumId, file);
  }

  return (Array.isArray(albums) ? albums : []).map((album) => {
    const albumId = String(album?.id);
    return {
      albumId,
      tracks: tracksByAlbumId.get(albumId) || [],
      files: [...(filesByAlbumId.get(albumId)?.values() || [])],
    };
  });
}

async function loadAlbumTrackData(client, albums, artistIds) {
  const loadPerAlbumTrackData = () =>
    mapWithConcurrency(albums, 4, async (album) => {
      if (!album?.id) return { albumId: null, tracks: [], files: [] };
      const [tracks, files] = await Promise.all([
        client.getTracksByAlbumId(album.id),
        client.getTrackFilesByAlbumId(album.id),
      ]);
      return {
        albumId: String(album.id),
        tracks: Array.isArray(tracks) ? tracks : [],
        files: Array.isArray(files) ? files : [],
      };
    });

  if (
    typeof client.getAllTracks === "function" &&
    (typeof client.getTrackFilesByIds === "function" ||
      typeof client.getAllTrackFiles === "function")
  ) {
    let tracks;
    let files;
    if (typeof client.getTrackFilesByIds === "function") {
      tracks = await client.getAllTracks({
        artistIds,
        forceRefresh: true,
        throwOnError: true,
      });
      files = await client.getTrackFilesByIds(
        tracks.map((track) => track?.trackFileId),
        { forceRefresh: true, throwOnError: true },
      ).catch((error) => {
        if (typeof client.getAllTrackFiles !== "function") throw error;
        return client.getAllTrackFiles({
          artistIds,
          forceRefresh: true,
          throwOnError: true,
        });
      });
    } else {
      [tracks, files] = await Promise.all([
        client.getAllTracks({ artistIds, forceRefresh: true, throwOnError: true }),
        client.getAllTrackFiles({ artistIds, forceRefresh: true, throwOnError: true }),
      ]);
    }
    return buildBulkAlbumTrackData(albums, tracks, files);
  }

  return loadPerAlbumTrackData();
}

function resolveTrackFile(track, fileIndex, album) {
  if (track?.albumId != null && String(track.albumId) !== String(album?.id)) return null;
  const file =
    fileIndex.get(`file:${track?.trackFileId}`) ||
    fileIndex.get(`track:${track?.id}`) ||
    track?.trackFile ||
    track?.file ||
    null;
  if (file?.albumId != null && String(file.albumId) !== String(album?.id)) return null;
  const externalPath =
    track?.path ||
    file?.path ||
    (file?.relativePath && album?.path ? path.join(album.path, file.relativePath) : null);
  if (!externalPath) return null;
  return {
    externalPath,
    localPath: resolveLocalPath(externalPath, getPathMappings("lidarr")),
    file,
  };
}

async function readFileStats(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

const FILE_STAT_CONCURRENCY = 16;

const artistFingerprint = (artist) => JSON.stringify({
  statistics: artist?.statistics ?? null,
  lastInfoSync: artist?.lastInfoSync ?? null,
  path: artist?.path ?? null,
});

// Lidarr artists whose stored statistics, lastInfoSync, and path match the
// fresh resource have no new, removed, upgraded, or retagged files, so their
// track and file reads are skipped. Only trusted when the previous full Lidarr
// scan completed; a failed run may have written artist rows without tracks.
function findUnchangedLidarrArtists(artists) {
  const lastRun = db.prepare(
    "SELECT status FROM library_scan_runs WHERE source = 'lidarr' ORDER BY id DESC LIMIT 1",
  ).get();
  if (lastRun?.status !== "complete") return new Map();
  const stored = new Map(
    db.prepare(
      `SELECT id,
         CAST(json_extract(metadata_json, '$.id') AS TEXT) AS provider_id,
         json_object(
           'statistics', json_extract(metadata_json, '$.statistics'),
           'lastInfoSync', json_extract(metadata_json, '$.lastInfoSync'),
           'path', json_extract(metadata_json, '$.path')
         ) AS fingerprint
       FROM library_artists
       WHERE json_valid(metadata_json)
         AND json_extract(metadata_json, '$.librarySource') = 'lidarr'`,
    ).all().map((row) => [row.provider_id, row]),
  );
  const unchanged = new Map();
  for (const artist of artists) {
    // A resource without statistics carries nothing to compare against.
    if (!artist?.statistics || typeof artist.statistics !== "object") continue;
    const row = stored.get(String(artist?.id));
    if (row && row.fingerprint === artistFingerprint(artist)) unchanged.set(String(artist.id), row.id);
  }
  return unchanged;
}

const normalizeScopedArtistIds = (artistIds) => [
  ...new Set(
    (Array.isArray(artistIds) ? artistIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  ),
];

async function loadScopedArtists(client, artistIds) {
  const artists = await mapWithConcurrency(artistIds, 4, async (artistId) => {
    try {
      const artist = await client.getArtist(artistId);
      return artist && artist.id != null ? artist : null;
    } catch {
      return null;
    }
  });
  const found = artists.filter(Boolean);
  const albums = (await mapWithConcurrency(found, 4, async (artist) => {
    if (typeof client.getAlbumsByArtistId === "function") {
      return client.getAlbumsByArtistId(artist.id, { forceRefresh: true });
    }
    const all = await client.getAllAlbums({ forceRefresh: true });
    return all.filter((album) => String(album?.artistId) === String(artist.id));
  })).flat().filter(Boolean);
  return { artists: found, albums };
}

// `artistIds` limits the re-index to those Lidarr artists: only their albums,
// tracks, and files are fetched and reconciled, and only their media can be
// marked unavailable. The scan run is recorded under the "lidarr-artist"
// source so it neither counts as a completed full scan nor affects staleness.
export async function indexLidarrLibrary({
  client,
  syncSearch = true,
  artistIds = null,
  force = false,
} = {}) {
  if (!client || typeof client.isConfigured !== "function" || !client.isConfigured()) {
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }

  const scopedArtistIds = artistIds == null ? null : normalizeScopedArtistIds(artistIds);
  if (scopedArtistIds && scopedArtistIds.length === 0) {
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }
  let artists;
  let albums;
  let rootFolders;
  if (scopedArtistIds) {
    [{ artists, albums }, rootFolders] = await Promise.all([
      loadScopedArtists(client, scopedArtistIds),
      client.getRootFolders(),
    ]);
    if (artists.length === 0) {
      return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
    }
  } else {
    [artists, albums, rootFolders] = await Promise.all([
      client.request("/artist", "GET", null, false, { forceRefresh: true }),
      client.getAllAlbums({ forceRefresh: true }),
      client.getRootFolders(),
    ]);
  }
  if (
    Array.isArray(artists) &&
    artists.length === 0 &&
    Array.isArray(albums) &&
    albums.length === 0
  ) {
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }
  const artistById = new Map((Array.isArray(artists) ? artists : []).map((item) => [String(item.id), item]));
  // Maps Lidarr artist id to the canonical artist row id for skipped artists.
  const unchangedArtists = scopedArtistIds || force === true
    ? new Map()
    : findUnchangedLidarrArtists([...artistById.values()]);
  const changedAlbums = (Array.isArray(albums) ? albums : [])
    .filter((album) => !unchangedArtists.has(String(album?.artistId)));
  const albumTrackData = await loadAlbumTrackData(
    client,
    changedAlbums,
    [...artistById.values()]
      .filter((artist) => !unchangedArtists.has(String(artist?.id)))
      .map((artist) => artist?.id),
  );
  const tracksByAlbumId = new Map();
  const filesByAlbumId = new Map();
  for (const albumData of albumTrackData) {
    if (albumData.albumId) tracksByAlbumId.set(albumData.albumId, albumData.tracks);
    if (albumData.albumId) filesByAlbumId.set(albumData.albumId, buildFileIndex(albumData.files));
  }
  const rootPath = scopedArtistIds
    ? `artist:${scopedArtistIds.join(",")}`
    : (Array.isArray(rootFolders) ? rootFolders : [])
      .map((folder) => text(folder?.path))
      .filter(Boolean)
      .join(";") || null;
  const result = {
    filesSeen: 0,
    filesIndexed: 0,
    filesFailed: 0,
    artistsSkipped: unchangedArtists.size,
  };
  const tracksEnumerated = albumTrackData.some((albumData) => albumData.tracks.length > 0);

  return withLibraryScan(scopedArtistIds ? "lidarr-artist" : "lidarr", rootPath, async (scanId) => {
    const indexedFiles = new Map();
    const unseenPaths = scopedArtistIds ? new Set() : getAvailableLibraryMediaPaths("lidarr");
    if (unchangedArtists.size) {
      for (const filePath of getAvailableLibraryMediaPathsForArtists(
        "lidarr",
        [...unchangedArtists.values()],
      )) unseenPaths.delete(filePath);
    }
    const resolvedTracks = [];
    for (const album of changedAlbums) {
      for (const track of tracksByAlbumId.get(String(album?.id)) || []) {
        const resolvedFile = resolveTrackFile(
          track,
          filesByAlbumId.get(String(album?.id)) || new Map(),
          album,
        );
        if (!resolvedFile) continue;
        result.filesSeen += 1;
        resolvedTracks.push({ track, resolvedFile });
      }
    }
    await mapWithConcurrency(resolvedTracks, FILE_STAT_CONCURRENCY, async ({ track, resolvedFile }) => {
      const stat = await readFileStats(resolvedFile.localPath);
      if (!stat) {
        result.filesFailed += 1;
        return;
      }
      indexedFiles.set(track, { resolvedFile, stat });
    });

    const artistRecordsById = db.transaction(() => {
      const records = new Map();
      for (const artist of artistById.values()) {
        const artistProviderId = text(artist.foreignArtistId);
        const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
        const artistKey =
          (artistProviderId &&
            buildIdentityKey(isUuid(artistProviderId) ? "mbid" : "lidarr-artist", artistProviderId)) ||
          buildFallbackIdentityKey("lidarr-artist", artist.id, artistName);
        records.set(String(artist.id), upsertLibraryArtist({
          identityKey: artistKey,
          mbid: isUuid(artistProviderId) ? artistProviderId : null,
          name: artistName,
          sortName: artist.sortName || null,
          metadata: { ...slimLidarrArtist(artist), librarySource: "lidarr" },
          syncSearch,
        }));
      }
      return records;
    })();
    if (scopedArtistIds) {
      for (const filePath of getAvailableLibraryMediaPathsForArtists(
        "lidarr",
        [...artistRecordsById.values()].map((record) => record?.id),
      )) unseenPaths.add(filePath);
    }

    for (const album of Array.isArray(albums) ? albums : []) {
      const artist = artistById.get(String(album?.artistId));
      if (!artist || !album?.id) {
        result.filesFailed += 1;
        continue;
      }
      const batch = db.transaction(() => {
        const seenPaths = [];
        let filesIndexed = 0;
        const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
        const artistRecord = artistRecordsById.get(String(artist.id));
        const albumProviderId = text(album.foreignAlbumId);
        const albumKey =
          (albumProviderId &&
            buildIdentityKey(
              isUuid(albumProviderId) ? "release-group" : "lidarr-album",
              albumProviderId,
            )) ||
          buildFallbackIdentityKey("lidarr-album", album.id, album.title);
        const albumRecord = upsertLibraryAlbum({
          identityKey: albumKey,
          mbid: isUuid(albumProviderId) ? albumProviderId : null,
          releaseGroupMbid: isUuid(albumProviderId) ? albumProviderId : null,
          artistId: artistRecord.id,
          title: text(album.title) || "Unknown Album",
          albumArtist: artistName,
          releaseDate: album.releaseDate || null,
          metadata: { ...slimLidarrAlbum(album), librarySource: "lidarr" },
          syncSearch,
        });
        for (const track of tracksByAlbumId.get(String(album.id)) || []) {
          const trackProviderId = text(track.foreignRecordingId || track.foreignTrackId);
          const trackKey =
            (trackProviderId &&
              buildIdentityKey(isUuid(trackProviderId) ? "recording" : "lidarr-track", trackProviderId)) ||
            buildFallbackIdentityKey("lidarr-track", albumRecord.id, track.id, track.title);
          const trackRecord = upsertLibraryTrack({
            identityKey: trackKey,
            mbid: isUuid(trackProviderId) ? trackProviderId : null,
            title: text(track.title || track.trackTitle) || "Unknown Track",
            artistName,
            metadata: slimLidarrTrack(track),
            syncSearch,
          });
          const trackNumber = Number(track.trackNumber || track.absoluteTrackNumber) || 0;
          linkLibraryAlbumTrack({
            albumId: albumRecord.id,
            trackId: trackRecord.id,
            discNumber: Number(track.mediumNumber || track.discNumber) || 1,
            trackNumber,
            syncSearch,
          });

          const indexedFile = indexedFiles.get(track);
          if (!indexedFile) continue;
          const { resolvedFile, stat } = indexedFile;
          upsertLibraryMediaFile({
            trackId: trackRecord.id,
            albumId: albumRecord.id,
            source: "lidarr",
            path: resolvedFile.localPath,
            format: path.extname(resolvedFile.localPath).slice(1).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            durationMs: track.duration || resolvedFile.file?.duration || null,
            quality: resolvedFile.file?.mediaInfo || track.mediaInfo || null,
            available: true,
            scanId,
          });
          seenPaths.push(resolvedFile.localPath);
          filesIndexed += 1;
        }
        return { filesIndexed, seenPaths };
      })();
      result.filesIndexed += batch.filesIndexed;
      for (const filePath of batch.seenPaths) unseenPaths.delete(filePath);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (result.filesFailed === 0 && (result.filesIndexed > 0 || tracksEnumerated)) {
      markLibraryMediaFilesUnavailable("lidarr", unseenPaths);
    }
    return result;
  });
}

export { buildFileIndex, resolveTrackFile };
