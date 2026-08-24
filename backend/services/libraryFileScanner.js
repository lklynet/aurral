import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  getAvailableLibraryMediaPaths,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.js";
import { parseAurralIdentityComment } from "./playlistDownloadUtils.js";

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
  "_flows",
  "_playlists",
  "_staging",
  "aurral-weekly-flow",
]);

export function isLibraryScanExcludedDirectory(name) {
  const value = String(name || "");
  return EXCLUDED_DIRECTORIES.has(value) || value.startsWith(".");
}

const text = (value) => String(value || "").trim();

const first = (value) => (Array.isArray(value) ? value[0] : value);

const numberPart = (value, fallback = 0) => {
  const number = Number(value?.no ?? value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

const normalizeMbid = (value) => text(first(value)) || null;

const normalizeMetadata = (metadata) => metadata?.common || {};

const applyMetadataEnrichment = (metadata, enrichment = null) => {
  const common = { ...normalizeMetadata(metadata) };
  const embedded = parseAurralIdentityComment(common.comment);
  if ((!enrichment || typeof enrichment !== "object") && !embedded) return metadata;
  const trusted = { ...(embedded || {}), ...(enrichment || {}) };
  const fallbackFields = {
    albumartist: trusted.artistName,
    artist: trusted.artistName,
    album: trusted.albumName,
    title: trusted.trackName,
    date: trusted.releaseYear,
    track: trusted.trackNumber,
    musicbrainz_artistid: trusted.artistMbid,
    musicbrainz_albumartistid: trusted.artistMbid,
    musicbrainz_albumid: trusted.albumMbid,
    musicbrainz_releasegroupid: trusted.albumMbid,
    musicbrainz_recordingid: trusted.trackMbid,
    musicbrainz_trackid: trusted.trackMbid,
  };
  for (const [key, value] of Object.entries(fallbackFields)) {
    if (value == null || String(value).trim() === "") continue;
    if (common[key] == null || String(common[key]).trim() === "") common[key] = value;
  }
  return { ...(metadata || {}), common };
};

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
      if (isLibraryScanExcludedDirectory(entry.name)) continue;
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
  filePaths = null,
  metadataReader = parseFile,
  metadataEnricher = null,
  syncSearch = true,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  await fs.mkdir(resolvedRoot, { recursive: true });
  const requestedFiles = Array.isArray(filePaths)
    ? [...new Set(filePaths.map((filePath) => path.resolve(String(filePath || ""))))].filter(
        (filePath) => {
          const relative = path.relative(resolvedRoot, filePath);
          return (
            relative &&
            !relative.startsWith("..") &&
            !path.isAbsolute(relative) &&
            AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
          );
        },
      )
    : null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const unseenPaths = requestedFiles ? null : getAvailableLibraryMediaPaths(source);
  const scanResult = await withLibraryScan(source, resolvedRoot, (scanId) => {
    const run = async () => {
      const files = requestedFiles || walkAudioFiles(resolvedRoot);
      for await (const filePath of files) {
        result.filesSeen += 1;
        try {
          const [metadata, stat] = await Promise.all([
            metadataReader(filePath, { skipCovers: true }),
            fs.stat(filePath),
          ]);
          const enrichedMetadata = applyMetadataEnrichment(
            metadata,
            typeof metadataEnricher === "function"
              ? await metadataEnricher(metadata, filePath)
              : null,
          );
          const record = buildMetadataRecord(enrichedMetadata, filePath, resolvedRoot);
          const artist = upsertLibraryArtist({
            identityKey: record.artistKey,
            mbid: record.artistMbid,
            name: record.artistName,
            metadata: record.artistMetadata,
            syncSearch,
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
            syncSearch,
          });
          const track = upsertLibraryTrack({
            identityKey: record.trackKey,
            mbid: record.trackMbid,
            title: record.title,
            artistName: record.artistName,
            metadata: record.trackMetadata,
            syncSearch,
          });
          linkLibraryAlbumTrack({
            albumId: album.id,
            trackId: track.id,
            discNumber: record.discNumber,
            trackNumber: record.trackNumber,
            syncSearch,
          });
          upsertLibraryMediaFile({
            trackId: track.id,
            albumId: album.id,
            source,
            path: filePath,
            format: path.extname(filePath).slice(1).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            durationMs: record.durationMs,
            quality: record.quality,
            scanId,
          });
          unseenPaths?.delete(filePath);
          result.filesIndexed += 1;
        } catch {
          result.filesFailed += 1;
        }
      }
      if (unseenPaths && result.filesFailed === 0) {
        markLibraryMediaFilesUnavailable(source, unseenPaths);
      }
      return result;
    };
    return run();
  });
  return scanResult;
}

export { buildMetadataRecord, readPathFallback, AUDIO_EXTENSIONS };
