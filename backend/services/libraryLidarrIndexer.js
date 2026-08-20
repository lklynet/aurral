import fs from "fs/promises";
import path from "path";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  linkLibraryAlbumTrack,
  markUnseenFilesUnavailable,
  removeLibraryAlbumTracksWithoutMedia,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";
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
    try {
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
        );
      } else {
        [tracks, files] = await Promise.all([
          client.getAllTracks({ artistIds, forceRefresh: true, throwOnError: true }),
          client.getAllTrackFiles({ artistIds, forceRefresh: true, throwOnError: true }),
        ]);
      }
      return buildBulkAlbumTrackData(albums, tracks, files);
    } catch {
      return loadPerAlbumTrackData();
    }
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

export async function indexLidarrLibrary({ client } = {}) {
  if (!client || typeof client.isConfigured !== "function" || !client.isConfigured()) {
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }

  const [artists, albums, rootFolders] = await Promise.all([
    client.request("/artist", "GET", null, false, { forceRefresh: true }),
    client.getAllAlbums({ forceRefresh: true }),
    client.getRootFolders(),
  ]);
  if (
    Array.isArray(artists) &&
    artists.length === 0 &&
    Array.isArray(albums) &&
    albums.length === 0
  ) {
    return { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  }
  const artistById = new Map((Array.isArray(artists) ? artists : []).map((item) => [String(item.id), item]));
  const albumTrackData = await loadAlbumTrackData(
    client,
    albums,
    (Array.isArray(artists) ? artists : []).map((artist) => artist?.id),
  );
  const tracksByAlbumId = new Map();
  const filesByAlbumId = new Map();
  for (const albumData of albumTrackData) {
    if (albumData.albumId) tracksByAlbumId.set(albumData.albumId, albumData.tracks);
    if (albumData.albumId) filesByAlbumId.set(albumData.albumId, buildFileIndex(albumData.files));
  }
  const rootPath = (Array.isArray(rootFolders) ? rootFolders : [])
    .map((folder) => text(folder?.path))
    .filter(Boolean)
    .join(";") || null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };

  return withLibraryScan("lidarr", rootPath, async (scanId) => {
    for (const album of Array.isArray(albums) ? albums : []) {
      const artist = artistById.get(String(album?.artistId));
      if (!artist || !album?.id) continue;
      const artistProviderId = text(artist.foreignArtistId);
      const artistName = text(artist.artistName || artist.name) || "Unknown Artist";
      const artistKey =
        (artistProviderId &&
          buildIdentityKey(isUuid(artistProviderId) ? "mbid" : "lidarr-artist", artistProviderId)) ||
        buildFallbackIdentityKey("lidarr-artist", artist.id, artistName);
      const artistRecord = upsertLibraryArtist({
        identityKey: artistKey,
        mbid: isUuid(artistProviderId) ? artistProviderId : null,
        name: artistName,
        sortName: artist.sortName || null,
        metadata: artist,
      });
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
        metadata: album,
      });
      let albumFilesIndexed = 0;

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
          metadata: track,
        });
        const trackNumber = Number(track.trackNumber || track.absoluteTrackNumber) || 0;
        linkLibraryAlbumTrack({
          albumId: albumRecord.id,
          trackId: trackRecord.id,
          discNumber: Number(track.mediumNumber || track.discNumber) || 1,
          trackNumber,
        });

        const resolvedFile = resolveTrackFile(
          track,
          filesByAlbumId.get(String(album.id)) || new Map(),
          album,
        );
        if (!resolvedFile) continue;
        result.filesSeen += 1;
        const stat = await readFileStats(resolvedFile.localPath);
        if (!stat) {
          result.filesFailed += 1;
          continue;
        }
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
        result.filesIndexed += 1;
        albumFilesIndexed += 1;
      }
      if (
        albumFilesIndexed === 0 &&
        Number(album.statistics?.sizeOnDisk || 0) === 0
      ) {
        removeLibraryAlbumTracksWithoutMedia(albumRecord.id, "lidarr");
      }
    }
    if (result.filesFailed === 0 && result.filesIndexed > 0) {
      markUnseenFilesUnavailable(scanId, "lidarr");
    }
    return result;
  });
}

export { buildFileIndex, resolveTrackFile };
