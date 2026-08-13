import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  linkLibraryAlbumTrack,
  markUnseenFilesUnavailable,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wv",
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "_fallback",
  "_playlists",
  "_staging",
  "aurral-weekly-flow",
]);

const text = (value) => String(value || "").trim();

const first = (value) => (Array.isArray(value) ? value[0] : value);

const numberPart = (value, fallback = 0) => {
  const number = Number(value?.no ?? value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

const normalizeMbid = (value) => text(first(value)) || null;

const normalizeMetadata = (metadata) => metadata?.common || {};

function readPathFallback(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const fileName = path.basename(filePath, path.extname(filePath));
  return {
    artistName: text(segments.at(-3)) || "Unknown Artist",
    albumName: text(segments.at(-2)) || "Unknown Album",
    title: text(fileName.replace(/^\d+(?:[. _-]+|$)/, "")) || fileName,
    trackNumber: Number.parseInt(fileName.match(/^\d+/)?.[0] || "0", 10) || 0,
    discNumber: 1,
  };
}

function buildMetadataRecord(metadata, filePath, rootPath) {
  const common = normalizeMetadata(metadata);
  const fallback = readPathFallback(filePath, rootPath);
  const artistName = text(common.albumartist || common.artist) || fallback.artistName;
  const albumName = text(common.album) || fallback.albumName;
  const title = text(common.title) || fallback.title;
  const trackNumber = numberPart(common.track, fallback.trackNumber);
  const discNumber = numberPart(common.disk, fallback.discNumber) || 1;
  const artistMbid = normalizeMbid(common.musicbrainz_albumartistid || common.musicbrainz_artistid);
  const albumMbid = normalizeMbid(common.musicbrainz_albumid);
  const releaseGroupMbid = normalizeMbid(common.musicbrainz_releasegroupid);
  const trackMbid = normalizeMbid(
    common.musicbrainz_recordingid || common.musicbrainz_trackid,
  );
  const artistKey =
    (artistMbid && buildIdentityKey("mbid", artistMbid)) ||
    buildFallbackIdentityKey("artist", artistName);
  const albumKey =
    (releaseGroupMbid && buildIdentityKey("release-group", releaseGroupMbid)) ||
    (albumMbid && buildIdentityKey("album", albumMbid)) ||
    buildFallbackIdentityKey("album", artistKey, albumName);
  const trackKey =
    (trackMbid && buildIdentityKey("recording", trackMbid)) ||
    buildFallbackIdentityKey("track", albumKey, discNumber, trackNumber, title);

  return {
    artistKey,
    artistMbid,
    artistName,
    albumKey,
    albumMbid,
    releaseGroupMbid,
    albumName,
    trackKey,
    trackMbid,
    title,
    trackNumber,
    discNumber,
    albumArtist: text(common.albumartist) || artistName,
    releaseDate: text(common.releasedate || common.date) || null,
    artistMetadata: { tags: common },
    albumMetadata: { tags: common },
    trackMetadata: { tags: common },
    durationMs: Number.isFinite(Number(metadata?.format?.duration))
      ? Math.round(Number(metadata.format.duration) * 1000)
      : null,
    quality: {
      format: text(metadata?.format?.codec) || null,
      bitrate: Number.isFinite(Number(metadata?.format?.bitrate))
        ? Math.round(Number(metadata.format.bitrate))
        : null,
      sampleRate: Number.isFinite(Number(metadata?.format?.sampleRate))
        ? Number(metadata.format.sampleRate)
        : null,
      bitsPerSample: Number.isFinite(Number(metadata?.format?.bitsPerSample))
        ? Number(metadata.format.bitsPerSample)
        : null,
    },
  };
}

async function* walkAudioFiles(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walkAudioFiles(path.join(rootPath, entry.name));
      continue;
    }
    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(rootPath, entry.name);
    }
  }
}

export async function scanMusicRoot({
  rootPath,
  source = "aurral",
  metadataReader = parseFile,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  await fs.mkdir(resolvedRoot, { recursive: true });
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const scanResult = await withLibraryScan(source, resolvedRoot, (scanId) => {
    const run = async () => {
      for await (const filePath of walkAudioFiles(resolvedRoot)) {
        result.filesSeen += 1;
        try {
          const [metadata, stat] = await Promise.all([
            metadataReader(filePath, { skipCovers: true }),
            fs.stat(filePath),
          ]);
          const record = buildMetadataRecord(metadata, filePath, resolvedRoot);
          const artist = upsertLibraryArtist({
            identityKey: record.artistKey,
            mbid: record.artistMbid,
            name: record.artistName,
            metadata: record.artistMetadata,
          });
          const album = upsertLibraryAlbum({
            identityKey: record.albumKey,
            mbid: record.albumMbid,
            releaseGroupMbid: record.releaseGroupMbid,
            artistId: artist.id,
            title: record.albumName,
            albumArtist: record.albumArtist,
            releaseDate: record.releaseDate,
            metadata: record.albumMetadata,
          });
          const track = upsertLibraryTrack({
            identityKey: record.trackKey,
            mbid: record.trackMbid,
            title: record.title,
            artistName: record.artistName,
            metadata: record.trackMetadata,
          });
          linkLibraryAlbumTrack({
            albumId: album.id,
            trackId: track.id,
            discNumber: record.discNumber,
            trackNumber: record.trackNumber,
          });
          upsertLibraryMediaFile({
            trackId: track.id,
            source,
            path: filePath,
            format: path.extname(filePath).slice(1).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            durationMs: record.durationMs,
            quality: record.quality,
            scanId,
          });
          result.filesIndexed += 1;
        } catch {
          result.filesFailed += 1;
        }
      }
      if (result.filesFailed === 0) markUnseenFilesUnavailable(scanId, source);
      return result;
    };
    return run();
  });
  return scanResult;
}

export { buildMetadataRecord, readPathFallback, AUDIO_EXTENSIONS };
