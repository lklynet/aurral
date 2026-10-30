import fs from "fs/promises";
import path from "path";
import { parseFile, type ICommonTagsResult, type IFormat, type IOptions } from "music-metadata";
import { db } from "../config/db-sqlite.ts";
import { readRawLibraryMetadata } from "./libraryMetadata.ts";
import { asAppError } from "../../lib/errors.ts";
import type { LibraryAlbumsRow } from "../db/rows.ts";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  findLibraryAlbumByArtistTitle,
  findLibraryAlbumByReleaseMbid,
  findLibraryAlbumTrack,
  findLegacyKeyedLibraryFiles,
  followLibraryFileIdentity,
  getLibraryMediaFile,
  getAvailableLibraryMediaPaths,
  getLibraryMediaPaths,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  mergeReleaseKeyedLibraryAlbums,
  reconcileLibraryAlbums,
  releaseLibraryFileRows,
  removeMissingLibraryMediaFiles,
  setLibraryAlbumCredits,
  splitLegacyKeyedLibraryRows,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "./libraryMediaStore.ts";
import { getLibraryManagementEntry, setLibraryManagement } from "./libraryManagementStore.ts";
import {
  readAurralIdentity,
  type AurralIdentity,
  type DownloadTrackFields,
} from "./downloadUtils.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

type ScannedMetadata = {
  common?: Partial<ICommonTagsResult>;
  format?: Partial<IFormat>;
};

type MetadataEnrichment = DownloadTrackFields | null | undefined;

type MetadataEnricher = (
  metadata: ScannedMetadata,
  filePath: string,
) => MetadataEnrichment | Promise<MetadataEnrichment>;

type ScanOptions = {
  rootPath: string;
  source?: string;
  filePaths?: string[] | null;
  changedPaths?: string[] | null;
  force?: boolean;
  metadataReader?: (filePath: string, options: IOptions) => Promise<ScannedMetadata>;
  metadataEnricher?: MetadataEnricher | null;
  syncSearch?: boolean;
  isExcluded?: (filePath: string) => boolean;
  changedFiles?: Set<string>;
};

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

export function isLibraryScanExcludedDirectory(name: unknown) {
  const value = String(name || "");
  return EXCLUDED_DIRECTORIES.has(value) || value.startsWith(".");
}

const text = (value: unknown) => String(value || "").trim();

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

const numberPart = (value: { no?: number | null } | null | undefined, fallback = 0) => {
  const number = Number(value?.no ?? value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
};

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// MusicBrainz IDs are lower case. A tag in capitals names the same ID, and
// one in another shape holds another service's ID.
const normalizeMbid = (value: unknown) => {
  const id = text(first(value)).toLowerCase();
  return MBID_PATTERN.test(id) ? id : null;
};

const normalizeMetadata = (
  metadata: ScannedMetadata | null | undefined,
): Partial<ICommonTagsResult> => metadata?.common || {};

const readEmbeddedAurralIdentity = (metadata: ScannedMetadata): AurralIdentity =>
  readAurralIdentity(metadata) || {};

const applyMetadataEnrichment = (
  metadata: ScannedMetadata,
  enrichment: MetadataEnrichment = null,
) => {
  const common: Partial<ICommonTagsResult> & Record<string, unknown> = {
    ...normalizeMetadata(metadata),
  };
  const embedded = readEmbeddedAurralIdentity(metadata);
  if ((!enrichment || typeof enrichment !== "object") && Object.keys(embedded).length === 0) {
    return metadata;
  }
  const trusted: DownloadTrackFields = { ...embedded, ...(enrichment || {}) };
  const fallbackFields = {
    albumartist: trusted.artistName,
    artist: trusted.artistName,
    album: trusted.albumName,
    title: trusted.trackName,
    date: trusted.releaseYear,
    track: trusted.trackNumber,
    disk: trusted.discNumber,
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

function readPathFallback(filePath: string, rootPath: string) {
  const relative = path.relative(rootPath, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const fileName = path.basename(filePath, path.extname(filePath));
  const position = /^(?:([1-9])-(?=\d{2,3}(?:[. _]|$)))?(\d+)(?:[. _-]+|$)/.exec(fileName);
  return {
    artistName: text(segments.at(-3)) || "Unknown Artist",
    albumName: text(segments.at(-2)) || "Unknown Album",
    title: text(position ? fileName.slice(position[0].length) : fileName) || fileName,
    trackNumber: Number.parseInt(position?.[2] || "0", 10) || 0,
    discNumber: Number.parseInt(position?.[1] || "1", 10) || 1,
  };
}

function buildMetadataRecord(metadata: ScannedMetadata, filePath: string, rootPath: string) {
  const common = normalizeMetadata(metadata);
  const fallback = readPathFallback(filePath, rootPath);
  const artistName = text(common.albumartist || common.artist) || fallback.artistName;
  const albumName = text(common.album) || fallback.albumName;
  const title = text(common.title) || fallback.title;
  const trackNumber = numberPart(common.track, fallback.trackNumber);
  const discNumber = numberPart(common.disk, fallback.discNumber) || 1;
  const artistMbids = common.musicbrainz_albumartistid
    ? [
        ...new Set(
          [common.musicbrainz_albumartistid]
            .flat()
            .map(normalizeMbid)
            .filter((mbid) => mbid !== null),
        ),
      ]
    : [normalizeMbid(common.musicbrainz_artistid)].filter((mbid) => mbid !== null);
  const artistMbid = artistMbids.length === 1 ? artistMbids[0] : null;
  const albumMbid = normalizeMbid(common.musicbrainz_albumid);
  const releaseGroupMbid = normalizeMbid(common.musicbrainz_releasegroupid);
  const trackMbid = normalizeMbid(common.musicbrainz_recordingid || common.musicbrainz_trackid);
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
    artistMbids,
    artistName,
    albumKey,
    albumMbid,
    releaseGroupMbid,
    albumName,
    trackKey,
    trackMbid,
    trackArtistName: text(common.artist),
    title,
    trackNumber,
    discNumber,
    albumArtist: text(common.albumartist) || artistName,
    releaseDate: text(common.releasedate || common.date) || null,
    artistMetadata: { tags: common },
    albumMetadata: { tags: common },
    trackMetadata: { tags: common },
    durationMs: Number.isFinite(Number(metadata?.format?.duration))
      ? Math.round(Number(metadata.format!.duration) * 1000)
      : null,
    quality: {
      format: text(metadata?.format?.codec) || null,
      bitrate: Number.isFinite(Number(metadata?.format?.bitrate))
        ? Math.round(Number(metadata.format!.bitrate))
        : null,
      sampleRate: Number.isFinite(Number(metadata?.format?.sampleRate))
        ? Number(metadata.format!.sampleRate)
        : null,
      bitsPerSample: Number.isFinite(Number(metadata?.format?.bitsPerSample))
        ? Number(metadata.format!.bitsPerSample)
        : null,
    },
  };
}

async function* walkAudioFiles(
  rootPath: string,
  isExcluded: (filePath: string) => boolean = () => false,
): AsyncGenerator<string> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const directory = path.join(rootPath, entry.name);
      if (isLibraryScanExcludedDirectory(entry.name) || isExcluded(directory)) continue;
      yield* walkAudioFiles(directory, isExcluded);
      continue;
    }
    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(rootPath, entry.name);
    }
  }
}

function isPathWithin(rootPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const normalizePathKey = (value: unknown) => {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function createPathScopeMatcher(scopes: unknown[] | null = []) {
  const scopeKeys = new Set(
    (Array.isArray(scopes) ? scopes : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map(normalizePathKey),
  );

  return (candidatePath: unknown) => {
    if (!String(candidatePath || "").trim() || scopeKeys.size === 0) return false;
    let currentPath = path.resolve(String(candidatePath));
    while (true) {
      if (scopeKeys.has(normalizePathKey(currentPath))) return true;
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) return false;
      currentPath = parentPath;
    }
  };
}

async function resolveChangedFiles(
  rootPath: string,
  changedPaths: string[] | null,
  isExcluded: (filePath: string) => boolean,
) {
  const filePaths = new Set<string>();
  const namedFilePaths = new Set<string>();
  const reconcilePaths = new Set<string>();

  for (const value of Array.isArray(changedPaths) ? changedPaths : []) {
    const rawPath = String(value || "").trim();
    if (!rawPath) continue;
    const changedPath = path.resolve(rawPath);
    if (!isPathWithin(rootPath, changedPath) || isExcluded(changedPath)) continue;
    const relativeParts = path.relative(rootPath, changedPath).split(path.sep);
    if (relativeParts.slice(0, -1).some(isLibraryScanExcludedDirectory)) continue;

    let stat = null;
    let missing = false;
    try {
      stat = await fs.lstat(changedPath);
      if (stat.isSymbolicLink()) continue;
    } catch (error) {
      missing = asAppError(error)?.code === "ENOENT";
      if (!missing && !AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
        continue;
      }
    }

    if (stat?.isDirectory()) {
      if (isLibraryScanExcludedDirectory(relativeParts.at(-1))) continue;
      reconcilePaths.add(changedPath);
      try {
        for await (const filePath of walkAudioFiles(changedPath, isExcluded))
          filePaths.add(filePath);
      } catch (error) {
        if (asAppError(error)?.code !== "ENOENT") reconcilePaths.delete(changedPath);
      }
      continue;
    }

    if (
      stat?.isFile() ||
      missing ||
      AUDIO_EXTENSIONS.has(path.extname(changedPath).toLowerCase())
    ) {
      filePaths.add(changedPath);
      namedFilePaths.add(changedPath);
      reconcilePaths.add(changedPath);
      continue;
    }

    reconcilePaths.add(changedPath);
  }

  return {
    filePaths: [...filePaths],
    namedFilePaths,
    reconcilePaths: [...reconcilePaths],
  };
}

function normalizeScanPaths(rootPath: string, filePaths: string[] | null) {
  return [
    ...new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .map((filePath) => path.resolve(String(filePath || "")))
        .filter((filePath) => isPathWithin(rootPath, filePath)),
    ),
  ];
}

const albumHasLidarrFileStmt = db.prepare(
  "SELECT 1 FROM library_media_files WHERE album_id = ? AND source = 'lidarr' AND available = 1 LIMIT 1",
);

const trackPerformerStmt = db.prepare<
  [string | null, string, string, string | null],
  { artist_tag: string }
>(
  `SELECT artist_tag FROM (
     SELECT media.path, media.artist_tag FROM library_tracks AS track
     JOIN library_media_files AS media ON media.track_id = track.id
     WHERE track.identity_key = ? AND media.available = 1 AND media.artist_tag IS NOT NULL AND media.path <> ?
     UNION ALL SELECT ?, ?
   ) WHERE artist_tag IS NOT NULL
   ORDER BY path
   LIMIT 1`,
);

const trackCreditedStmt = db.prepare(
  "SELECT 1 FROM library_tracks WHERE identity_key = ? AND artist_name IS NOT NULL",
);

// A root with nothing in it is a drive that is not connected, so its files
// are only marked missing and come back with it. Anywhere else, a file the
// scan cannot find is gone.
async function forgetMissingFiles(source: string, rootPath: string, paths: string[]) {
  const entries = await fs.readdir(rootPath).catch(() => []);
  return entries.some((name) => !isLibraryScanExcludedDirectory(name))
    ? removeMissingLibraryMediaFiles(source, paths)
    : markLibraryMediaFilesUnavailable(source, paths);
}

function claimUnownedAlbum(
  album: Pick<LibraryAlbumsRow, "id" | "identity_key" | "artist_id" | "title">,
) {
  if (getLibraryManagementEntry("album", album.id) || albumHasLidarrFileStmt.get(album.id)) return;
  setLibraryManagement({ entityKind: "album", entityId: album.id, managedBy: "aurral" });
  upsertLibraryAlbum({
    identityKey: album.identity_key,
    artistId: album.artist_id,
    title: album.title,
    metadata: { monitored: false },
    syncSearch: false,
  });
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
  isExcluded = () => false,
  changedFiles = new Set(),
}: Partial<ScanOptions> = {}) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  if (source !== "readonly") await fs.mkdir(resolvedRoot, { recursive: true });
  mergeReleaseKeyedLibraryAlbums();
  const changed = Array.isArray(changedPaths)
    ? await resolveChangedFiles(resolvedRoot, changedPaths, isExcluded)
    : null;
  const requestedFiles = changed
    ? normalizeScanPaths(resolvedRoot, changed.filePaths).filter((filePath) =>
        AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
      )
    : Array.isArray(filePaths)
      ? normalizeScanPaths(resolvedRoot, filePaths).filter(
          (filePath) =>
            AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !isExcluded(filePath),
        )
      : null;
  const reconcilePaths = changed?.reconcilePaths || null;
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  const unseenPaths = requestedFiles ? null : getLibraryMediaPaths(source);
  const legacyKeyed = findLegacyKeyedLibraryFiles(source);
  const legacyMoves: Parameters<typeof splitLegacyKeyedLibraryRows>[0] = [];
  const seenPaths = new Set<string>();
  const failedPaths = new Set<string>();
  const missingFilePaths = new Set<string>();
  let firstFailure: { filePath: string; reason: ReturnType<typeof safeLogDiagnostic> } | null =
    null;
  const scanResult = await withLibraryScan(source, resolvedRoot, (scanId) => {
    const run = async () => {
      const files = requestedFiles || walkAudioFiles(resolvedRoot, isExcluded);
      for await (const filePath of files) {
        result.filesSeen += 1;
        try {
          const stat = await fs.stat(filePath);
          const existing = getLibraryMediaFile({ source, path: filePath });
          if (
            force !== true &&
            !changed?.namedFilePaths.has(filePath) &&
            !legacyKeyed.paths.has(filePath) &&
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
          const enrichment =
            typeof metadataEnricher === "function"
              ? await metadataEnricher(metadata, filePath)
              : null;
          const enrichedMetadata = applyMetadataEnrichment(metadata, enrichment);
          const downloadedByAurral =
            Boolean(enrichment) || Object.keys(readEmbeddedAurralIdentity(metadata)).length > 0;
          const record = buildMetadataRecord(enrichedMetadata, filePath, resolvedRoot);
          const legacyArtistId =
            existing?.album_id && legacyKeyed.paths.has(filePath)
              ? db
                  .prepare<[number], Pick<LibraryAlbumsRow, "artist_id">>(
                    "SELECT artist_id FROM library_albums WHERE id = ?",
                  )
                  .get(existing.album_id)?.artist_id
              : null;
          const artist = upsertLibraryArtist({
            identityKey: record.artistKey,
            mbid: record.artistMbid,
            creditedMbids: record.artistMbids,
            name: record.artistName,
            metadata: record.artistMetadata,
            syncSearch,
          });
          const titledAlbum =
            !record.releaseGroupMbid && !record.albumMbid
              ? findLibraryAlbumByArtistTitle(artist.id, record.albumName, record.title)
              : null;
          const namedAlbum =
            titledAlbum && legacyKeyed.albumIds.has(titledAlbum.id) ? null : titledAlbum;
          const releaseAlbum = findLibraryAlbumByReleaseMbid(record.releaseGroupMbid) || namedAlbum;
          const albumKey = releaseAlbum?.identity_key || record.albumKey;
          const listedTrack =
            record.trackMbid || legacyKeyed.paths.has(filePath)
              ? null
              : findLibraryAlbumTrack(albumKey, record);
          const trackKey = listedTrack?.identity_key || record.trackKey;
          const before =
            existing && !legacyKeyed.paths.has(filePath)
              ? followLibraryFileIdentity(existing, {
                  artistId: artist.id,
                  albumKey,
                  albumTitle: namedAlbum?.title || record.albumName,
                  trackKey,
                  title: record.title,
                })
              : null;
          const album = upsertLibraryAlbum({
            identityKey: albumKey,
            mbid: releaseAlbum?.mbid || record.albumMbid,
            releaseGroupMbid: releaseAlbum?.release_group_mbid || record.releaseGroupMbid,
            artistId: artist.id,
            title: namedAlbum?.title || record.albumName,
            albumArtist: record.albumArtist,
            releaseDate: record.releaseDate,
            metadata: record.albumMetadata,
            syncSearch,
          });
          if (record.artistMbids.length) setLibraryAlbumCredits(album.id, record.artistMbids);
          if (source === "aurral" || source === "readonly") claimUnownedAlbum(album);
          const track = upsertLibraryTrack({
            identityKey: trackKey,
            mbid: listedTrack?.mbid || record.trackMbid,
            title: trackKey !== record.trackKey ? listedTrack!.title : record.title,
            artistName:
              trackPerformerStmt.get(trackKey, filePath, filePath, record.trackArtistName || null)
                ?.artist_tag ?? (trackCreditedStmt.get(trackKey) ? null : record.artistName),
            metadata: {
              ...readRawLibraryMetadata(listedTrack?.metadata_json),
              ...record.trackMetadata,
            },
            monitored: source === "readonly" ? false : source !== "aurral" || downloadedByAurral,
            syncSearch,
          });
          linkLibraryAlbumTrack({
            albumId: album.id,
            trackId: track.id,
            discNumber: record.discNumber,
            trackNumber: record.trackNumber,
            keepPosition: true,
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
            artistTag: record.trackArtistName,
            scanId,
          });
          if (before) releaseLibraryFileRows(before, { albumId: album.id, trackId: track.id });
          if (legacyKeyed.paths.has(filePath) && existing) {
            legacyMoves.push({
              fromTrackId: existing.track_id,
              toTrackId: track.id,
              fromAlbumId: existing.album_id,
              toAlbumId: album.id,
              fromArtistId: legacyArtistId,
              toArtistId: artist.id,
            });
          }
          unseenPaths?.delete(filePath);
          seenPaths.add(filePath);
          changedFiles.add(filePath);
          result.filesIndexed += 1;
        } catch (error) {
          result.filesFailed += 1;
          if (asAppError(error)?.code === "ENOENT") missingFilePaths.add(filePath);
          else {
            failedPaths.add(filePath);
            firstFailure ||= { filePath, reason: safeLogDiagnostic(error) };
          }
        }
      }
      if (firstFailure) {
        logger.warn("library", "Library scan could not index files", {
          source,
          failed: failedPaths.size,
          example: firstFailure.filePath,
          reason: firstFailure.reason,
        });
      }
      if (unseenPaths && result.filesFailed === 0) {
        const walked = (filePath: string) =>
          isPathWithin(resolvedRoot, filePath) &&
          !isExcluded(filePath) &&
          !path
            .relative(resolvedRoot, path.dirname(filePath))
            .split(path.sep)
            .some(isLibraryScanExcludedDirectory);
        const unseen = [...unseenPaths];
        for (const filePath of [
          ...(await forgetMissingFiles(source, resolvedRoot, unseen.filter(walked))),
          ...markLibraryMediaFilesUnavailable(
            source,
            unseen.filter((filePath) => !walked(filePath)),
          ),
        ])
          changedFiles.add(filePath);
      }
      if (requestedFiles) {
        const scopes = reconcilePaths || requestedFiles;
        const matchesReconcileScope = createPathScopeMatcher(scopes);
        const missingIndexedPaths = [...getAvailableLibraryMediaPaths(source, scopes)].filter(
          (filePath) =>
            matchesReconcileScope(filePath) &&
            !seenPaths.has(filePath) &&
            !failedPaths.has(filePath),
        );
        const unavailablePaths = [...missingFilePaths, ...missingIndexedPaths];
        if (unavailablePaths.length > 0) {
          for (const filePath of await forgetMissingFiles(source, resolvedRoot, unavailablePaths)) {
            changedFiles.add(filePath);
          }
        }
      }
      return result;
    };
    // Files already filed under rows of their own keep what the shared rows
    // had, even when the walk stops partway.
    return run().finally(() => {
      if (legacyMoves.length > 0) splitLegacyKeyedLibraryRows(legacyMoves);
      reconcileLibraryAlbums();
    });
  });
  return scanResult;
}

export async function scanMusicRoots({
  rootPaths = [],
  changedPaths = null,
  changedFiles = new Set(),
  ...options
}: Omit<ScanOptions, "rootPath"> & { rootPaths?: (string | null | undefined)[] } = {}) {
  const roots = [
    ...new Set(
      (Array.isArray(rootPaths) ? rootPaths : [])
        .map((rootPath) => String(rootPath ?? "").trim())
        .filter(Boolean)
        .map((rootPath) => path.resolve(rootPath)),
    ),
  ];
  if (Array.isArray(changedPaths)) {
    const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
    for (const rootPath of roots) {
      const paths = changedPaths.filter((changedPath) => isPathWithin(rootPath, changedPath));
      if (paths.length === 0) continue;
      try {
        const scan = await scanMusicRoot({
          ...options,
          changedFiles,
          rootPath,
          changedPaths: paths,
        });
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
  const source = options.source || "aurral";
  const unseenPaths = getLibraryMediaPaths(source);
  const result = { filesSeen: 0, filesIndexed: 0, filesFailed: 0, changed: false };
  const scannedRoots = [];

  for (const rootPath of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(rootPath);
    } catch (error) {
      if (asAppError(error)?.code === "ENOENT") continue;
      result.filesFailed += 1;
      continue;
    }
    if (!rootStat.isDirectory()) {
      result.filesFailed += 1;
      continue;
    }

    try {
      const filePaths: string[] = [];
      for await (const filePath of walkAudioFiles(rootPath, options.isExcluded)) {
        filePaths.push(filePath);
      }
      const scan = await scanMusicRoot({ ...options, changedFiles, rootPath, filePaths });
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

  const forgotten = [];
  for (const rootPath of scannedRoots) {
    const missingPaths = [...unseenPaths].filter((filePath) => {
      const relative = path.relative(rootPath, filePath);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (missingPaths.length > 0)
      forgotten.push(...(await forgetMissingFiles(source, rootPath, missingPaths)));
  }
  for (const filePath of forgotten) changedFiles.add(filePath);
  if (forgotten.length > 0) {
    result.changed = true;
    reconcileLibraryAlbums();
  }

  return result;
}

export { applyMetadataEnrichment, buildMetadataRecord, readPathFallback, AUDIO_EXTENSIONS };
