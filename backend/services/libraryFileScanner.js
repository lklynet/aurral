import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  getLibraryMediaFile,
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

const parseNativeAurralIdentityComment = (metadata) => {
  for (const tags of Object.values(metadata?.native || {})) {
    if (!Array.isArray(tags)) continue;

    for (const tag of tags) {
      const id = String(tag?.id || "").toLowerCase();
      if (id !== "txxx:comment" && id !== "comm") continue;

      const embedded = parseAurralIdentityComment(tag?.value);
      if (embedded) return embedded;
    }
  }

  return null;
};

const applyMetadataEnrichment = (metadata, enrichment = null) => {
  const common = { ...normalizeMetadata(metadata) };
  const embedded =
    parseAurralIdentityComment(common.comment) ||
    parseNativeAurralIdentityComment(metadata);
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

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveChangedFiles(rootPath, changedPaths) {
  const filePaths = new Set();
  const reconcilePaths = new Set();

  for (const value of Array.isArray(changedPaths) ? changedPaths : []) {
    const rawPath = String(value || "").trim();
    if (!rawPath) continue;
    const changedPath = path.resolve(rawPath);
    if (!isPathWithin(rootPath, changedPath)) continue;

    let stat = null;
    let missing = false;
    try {
      stat = await fs.lstat(changedPath);
      if (stat.isSymbolicLink()) continue;
    } catch (error) {
      missing = error?.code === "ENOENT";
      if (!missing && !AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
        continue;
      }
    }

    if (stat?.isDirectory()) {
      reconcilePaths.add(changedPath);
      try {
        for await (const filePath of walkAudioFiles(changedPath)) filePaths.add(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") reconcilePaths.delete(changedPath);
      }
      continue;
    }

    if (stat?.isFile() || missing || AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
      filePaths.add(changedPath);
      reconcilePaths.add(changedPath);
      continue;
    }

    reconcilePaths.add(changedPath);
  }

  return {
    filePaths: [...filePaths],
    reconcilePaths: [...reconcilePaths],
  };
}

function normalizeScanPaths(rootPath, filePaths) {
  return [...new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((filePath) => path.resolve(String(filePath || "")))
      .filter((filePath) => isPathWithin(rootPath, filePath)),
  )];
}

export async function scanMusicRoot({
  rootPath,
  source = "aurral",
  filePaths = null,
  changedPaths = null,
  force = false,
  metadataReader = parseFile,
  metadataEnricher = null,
  syncSearch = true,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  await fs.mkdir(resolvedRoot, { recursive: true });
  const changed = Array.isArray(changedPaths)
    ? await resolveChangedFiles(resolvedRoot, changedPaths)
    : null;
  const requestedFiles = changed
    ? normalizeScanPaths(resolvedRoot, changed.filePaths).filter((filePath) =>
        AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
      )
    : Array.isArray(filePaths)
      ? normalizeScanPaths(resolvedRoot, filePaths).filter((filePath) =>
          AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
        )
      : null;
  const reconcilePaths = changed?.reconcilePaths || null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const unseenPaths = requestedFiles ? null : getAvailableLibraryMediaPaths(source);
  const seenPaths = new Set();
  const failedPaths = new Set();
  const missingFilePaths = new Set();
  const scanResult = await withLibraryScan(source, resolvedRoot, (scanId) => {
    const run = async () => {
      const files = requestedFiles || walkAudioFiles(resolvedRoot);
      for await (const filePath of files) {
        result.filesSeen += 1;
        try {
          const stat = await fs.stat(filePath);
          const existing = getLibraryMediaFile({ source, path: filePath });
          if (
            force !== true &&
            existing?.available === 1 &&
            Number(existing.size) === stat.size &&
            Number(existing.mtime_ms) === stat.mtimeMs
          ) {
            unseenPaths?.delete(filePath);
            seenPaths.add(filePath);
            result.filesIndexed += 1;
            continue;
          }
          const metadata = await metadataReader(filePath, { skipCovers: true });
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
          seenPaths.add(filePath);
          result.filesIndexed += 1;
        } catch (error) {
          result.filesFailed += 1;
          if (error?.code === "ENOENT") missingFilePaths.add(filePath);
          else failedPaths.add(filePath);
        }
      }
      if (unseenPaths && result.filesFailed === 0) {
        markLibraryMediaFilesUnavailable(source, unseenPaths);
      }
      if (requestedFiles) {
        const scopes = reconcilePaths || requestedFiles;
        const missingIndexedPaths = [...getAvailableLibraryMediaPaths(source)].filter((filePath) =>
          scopes.some((scope) => isPathWithin(scope, filePath)) &&
          !seenPaths.has(filePath) &&
          !failedPaths.has(filePath),
        );
        const unavailablePaths = [
          ...missingFilePaths,
          ...missingIndexedPaths,
        ];
        if (unavailablePaths.length > 0) {
          markLibraryMediaFilesUnavailable(source, unavailablePaths);
        }
      }
      return result;
    };
    return run();
  });
  return scanResult;
}

export async function scanMusicRoots({ rootPaths = [], changedPaths = null, ...options } = {}) {
  const roots = [...new Set(
    (Array.isArray(rootPaths) ? rootPaths : [])
      .map((rootPath) => String(rootPath ?? "").trim())
      .filter(Boolean)
      .map((rootPath) => path.resolve(rootPath)),
  )];
  if (Array.isArray(changedPaths)) {
    const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
    for (const rootPath of roots) {
      const paths = changedPaths.filter((changedPath) => isPathWithin(rootPath, changedPath));
      if (paths.length === 0) continue;
      try {
        const scan = await scanMusicRoot({ ...options, rootPath, changedPaths: paths });
        result.filesSeen += scan.filesSeen;
        result.filesIndexed += scan.filesIndexed;
        result.filesFailed += scan.filesFailed;
        result.changed ||= scan.changed;
      } catch {
        result.filesFailed += 1;
      }
    }
    return result;
  }
  const unseenPaths = getAvailableLibraryMediaPaths(options.source || "aurral");
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
  const scannedRoots = [];

  for (const rootPath of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(rootPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      result.filesFailed += 1;
      continue;
    }
    if (!rootStat.isDirectory()) {
      result.filesFailed += 1;
      continue;
    }

    try {
      const filePaths = [];
      for await (const filePath of walkAudioFiles(rootPath)) filePaths.push(filePath);
      const scan = await scanMusicRoot({ ...options, rootPath, filePaths });
      result.filesSeen += scan.filesSeen;
      result.filesIndexed += scan.filesIndexed;
      result.filesFailed += scan.filesFailed;
      result.changed ||= scan.changed;
      for (const filePath of filePaths) unseenPaths.delete(filePath);
      if (scan.filesFailed === 0) scannedRoots.push(rootPath);
    } catch {
      result.filesFailed += 1;
    }
  }

  if (scannedRoots.length > 0) {
    const missingPaths = [...unseenPaths].filter((filePath) =>
      scannedRoots.some((rootPath) => {
        const relative = path.relative(rootPath, filePath);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
      }),
    );
    result.changed = markLibraryMediaFilesUnavailable(options.source || "aurral", missingPaths) > 0
      || result.changed;
  }

  return result;
}

export { buildMetadataRecord, readPathFallback, AUDIO_EXTENSIONS };
