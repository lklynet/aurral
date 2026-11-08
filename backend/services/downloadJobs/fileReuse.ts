import fs from "fs/promises";
import path from "path";
import { db } from "../../config/db-sqlite.ts";
import { asAppError } from "../../../lib/errors.ts";
import { downloadTracker, type DownloadJob, type DownloadTrackInput } from "./downloadTracker.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { tracksShareMembership } from "../playlists/playlistTracks.ts";
import {
  buildLibraryReadModel,
  findLibraryArtist,
  findLibraryTracksForAlbum,
} from "../libraryReadModel.ts";
import { getLibraryForArtistReferences } from "../libraryQueryService.ts";
import { scheduleLibraryScan as scheduleLibraryScanJob } from "../libraryScanWorker.ts";
import {
  commitDownloadedFile,
  joinUnderRoot,
  normalizePositiveInteger,
  sanitizePathPart,
} from "../downloadUtils.ts";
import { AURRAL_FLOWS_DIR, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.ts";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";

type FolderSource = keyof typeof FOLDER_SOURCES;
type SourceOptions = {
  targetPlaylistType?: string | null;
  downloadRoot?: string | null;
  excludeJobIds?: string[] | null;
  allowLidarr?: boolean;
};
type ReuseTrackOptions = SourceOptions & {
  existingJobId?: string | null;
  skipHistory?: boolean;
  libraryScanChangedPaths?: string[] | null;
};
type RestoreOptions = SourceOptions & {
  requeueOnMissing?: boolean;
  resolveSource?: typeof resolveRepairTrackSource;
};
type ReuseSource = {
  sourceType: string;
  sourcePath: string;
  sourceJob?: DownloadJob | null;
  externalPath?: string;
  albumName: string | null;
};
type LibraryReadModel = ReturnType<typeof buildLibraryReadModel>;
type ReadArtist = LibraryReadModel["artists"][number];
type ReadAlbum = LibraryReadModel["albums"][number];
type ReadTrack = LibraryReadModel["tracks"][number];
export type RemovedFolderRequeue = {
  downloadRoot?: string;
  removedFolders?: string[];
  keptFolders?: string[];
  externalFiles?: boolean;
  reason?: string;
};

const VALID_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".m4a",
  ".ogg",
  ".opus",
  ".wav",
  ".aac",
  ".ape",
]);

function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function statFilesystemLocation(targetPath: string | null | undefined) {
  const resolved = path.resolve(String(targetPath || ""));
  if (!resolved) {
    throw new Error("empty path");
  }

  let current = resolved;
  while (true) {
    try {
      const stat = await fs.stat(current);
      if (stat.isFile()) {
        return fs.stat(path.dirname(current));
      }
      return stat;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Path not found: ${resolved}`);
      }
      current = parent;
    }
  }
}

export async function pathsShareDevice(
  leftPath: string | null | undefined,
  rightPath: string | null | undefined,
) {
  try {
    const [leftStat, rightStat] = await Promise.all([
      statFilesystemLocation(leftPath),
      statFilesystemLocation(rightPath),
    ]);
    return leftStat.dev === rightStat.dev;
  } catch {
    return false;
  }
}

export async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sortReusableJobs<T extends DownloadJob>(jobs: T[]): T[] {
  return [...jobs].sort((left, right) => {
    const leftCreated = Number(left?.createdAt || 0);
    const rightCreated = Number(right?.createdAt || 0);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}

/**
 * Checks whether a playlist type corresponds to an ephemeral Flow playlist.
 *
 * @param {string} playlistType - Target playlist identifier.
 * @returns {boolean} True if the playlist type is a configured flow.
 */
function isFlowPlaylistType(playlistType: string) {
  return Boolean(flowPlaylistConfig.getFlow(String(playlistType || "").trim()));
}

// Downloads are named "Title" or, with a known album position, "07 - Title",
// or "2-07 - Title" past the first disc. An album can repeat a title, so a
// known position must match too.
function isTrackFileBaseName(
  baseName: string,
  title: string,
  trackNumber: number | null,
  discNumber: number | null,
) {
  if (baseName === title) return true;
  const position =
    baseName.endsWith(` - ${title}`) &&
    /^(?:(\d+)-)?(\d{2,3}) - $/.exec(baseName.slice(0, -title.length));
  return (
    Boolean(position) &&
    (!trackNumber || Number((position as RegExpExecArray)[2]) === trackNumber) &&
    Number((position as RegExpExecArray)[1] || 1) === (discNumber || 1)
  );
}

/**
 * Scans local storage directories to locate an existing audio file matching track metadata.
 *
 * @param {object} track - Track metadata including artistName, albumName, and trackName.
 * @param {object} [options={}] - Options containing targetPlaylistType and downloadRoot.
 * @returns {Promise<{sourceType: string, sourcePath: string, sourceJob: null, albumName: string|null}|null>} Resolved source or null.
 */
async function findLocalExistingSource(
  track: DownloadTrackInput,
  options: SourceOptions = {},
): Promise<ReuseSource | null> {
  const targetPlaylistType = sanitizePathPart(options.targetPlaylistType, "");
  if (!targetPlaylistType) return null;

  const root = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const ephemeral = isFlowPlaylistType(targetPlaylistType);

  const artistDir = sanitizePathPart(track?.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(track?.albumName, "Unknown Album");
  const expectedBaseName = sanitizePathPart(track?.trackName, "Unknown Track");
  const trackNumber = normalizePositiveInteger(track?.trackNumber);
  const discNumber = normalizePositiveInteger(track?.discNumber);

  const candidateDirs = [
    ephemeral
      ? path.resolve(root, AURRAL_FLOWS_DIR, targetPlaylistType, artistDir, albumDir)
      : path.resolve(root, artistDir, albumDir),
  ];

  for (const destinationDir of candidateDirs) {
    if (!isPathInsideRoot(destinationDir, root)) continue;
    try {
      const files = await fs.readdir(destinationDir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const baseName = path.basename(file, ext);
        if (
          isTrackFileBaseName(baseName, expectedBaseName, trackNumber, discNumber) &&
          VALID_AUDIO_EXTENSIONS.has(ext)
        ) {
          const filePath = path.join(destinationDir, file);
          const resolvedFilePath = path.resolve(filePath);
          if (!isPathInsideRoot(resolvedFilePath, root)) continue;
          const stat = await fs.stat(resolvedFilePath);
          if (stat.isFile()) {
            return {
              sourceType: "aurral",
              sourcePath: resolvedFilePath,
              sourceJob: null,
              albumName: track?.albumName || null,
            };
          }
        }
      }
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code !== "ENOENT") {
        console.warn(
          `[FileReuse] Failed to check local existing source at ${destinationDir}: ${failure?.message}`,
        );
      }
    }
  }
  return null;
}

function tracksShareLibraryMembership(left: DownloadTrackInput, right: DownloadTrackInput) {
  const leftTrackMbid = String(left?.trackMbid || "").trim();
  const rightTrackMbid = String(right?.trackMbid || "").trim();
  if (leftTrackMbid && rightTrackMbid && leftTrackMbid !== rightTrackMbid) return false;

  const leftAlbumMbid = String(left?.albumMbid || "").trim();
  const rightAlbumMbid = String(right?.albumMbid || "").trim();
  if (leftAlbumMbid && rightAlbumMbid && leftAlbumMbid !== rightAlbumMbid) return false;

  const leftAlbumName = normalizeText(left?.albumName);
  const rightAlbumName = normalizeText(right?.albumName);
  if (leftAlbumName && rightAlbumName && leftAlbumName !== rightAlbumName) return false;

  return tracksShareMembership(left, right);
}

async function findAurralSource(
  track: DownloadTrackInput,
  options: SourceOptions = {},
): Promise<ReuseSource | null> {
  const targetPlaylistType = String(options.targetPlaylistType || "").trim();
  const excludeJobIds = new Set(
    (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const candidates = [];
  for (const job of downloadTracker.getDoneByTrackName(track.trackName)) {
    if (options.allowLidarr === false && job.managedBy === "lidarr") continue;
    if (excludeJobIds.has(String(job.id || ""))) continue;
    if (!job.finalPath || typeof job.finalPath !== "string") continue;
    const matches =
      targetPlaylistType === "library"
        ? tracksShareLibraryMembership(track, job)
        : tracksShareMembership(track, job);
    if (!matches) continue;
    if (targetPlaylistType && String(job.playlistType || "") === targetPlaylistType) {
      continue;
    }
    if (!(await fileExists(job.finalPath))) continue;
    candidates.push(job);
  }
  const staticJobs = candidates.filter((job) => !isFlowPlaylistType(job.playlistType));
  const flowJobs = candidates.filter((job) => isFlowPlaylistType(job.playlistType));
  const sourceJob = sortReusableJobs(staticJobs)[0] || sortReusableJobs(flowJobs)[0];
  if (!sourceJob) return null;
  return {
    sourceType: "aurral",
    sourcePath: path.resolve(sourceJob.finalPath!),
    sourceJob,
    albumName: sourceJob.albumName || track.albumName || null,
  };
}

export function jobDownloadedItsFile(job: DownloadJob | null | undefined) {
  return (
    job?.status === "done" &&
    Boolean(job.finalPath) &&
    job.managedBy === "aurral" &&
    !job.externalPath &&
    !job.reusedLibraryFile
  );
}

function noPlaylistDownloadedFile(filePath: string, jobId: string) {
  return !downloadTracker
    .getDoneByFinalPath(filePath)
    .some((job) => job.id !== jobId && job.playlistType !== "library" && jobDownloadedItsFile(job));
}

function retargetJobsToPath(oldPath: string, newPath: string, albumName: string | null = null) {
  const resolvedOld = path.resolve(oldPath);
  const resolvedNew = path.resolve(newPath);
  if (resolvedOld === resolvedNew) return;
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string") continue;
    if (path.resolve(job.finalPath) !== resolvedOld) continue;
    downloadTracker.setDone(
      job.id,
      resolvedNew,
      albumName || job.albumName || null,
      job.externalPath || null,
    );
  }
}

async function adoptFileIntoPlaylist(
  sourcePath: string,
  targetPlaylistType: string,
  downloadRoot: string,
  options: { track?: DownloadTrackInput } = {},
) {
  const safeTarget = String(targetPlaylistType || "").trim();
  const root = path.resolve(downloadRoot || resolveDownloadRoot());
  const resolvedSource = path.resolve(sourcePath);
  if (!safeTarget || !(await fileExists(resolvedSource))) return null;

  const flowsRoot = path.resolve(root, AURRAL_FLOWS_DIR);
  const targetRoot = isFlowPlaylistType(safeTarget) ? path.resolve(flowsRoot, safeTarget) : root;
  const inFlow = isPathInsideRoot(resolvedSource, flowsRoot);
  if (targetRoot === root ? !inFlow : isPathInsideRoot(resolvedSource, targetRoot)) {
    return resolvedSource;
  }

  const sourcePlaylistId = parsePlaylistIdFromFinalPath(resolvedSource);
  const sourceRoot = sourcePlaylistId ? path.resolve(flowsRoot, sourcePlaylistId) : null;
  const relative =
    sourceRoot && isPathInsideRoot(resolvedSource, sourceRoot)
      ? path.relative(sourceRoot, resolvedSource)
      : path.basename(resolvedSource);
  const segments = relative.split(path.sep).filter(Boolean);
  const artistDir = sanitizePathPart(
    options.track?.artistName || segments.at(-3),
    "Unknown Artist",
  );
  const albumDir = sanitizePathPart(options.track?.albumName || segments.at(-2), "Unknown Album");
  const destPath = joinUnderRoot(
    targetRoot,
    path.join(artistDir, albumDir),
    path.basename(resolvedSource),
  );
  const committed = await commitDownloadedFile(resolvedSource, destPath);
  retargetJobsToPath(resolvedSource, committed);
  return path.resolve(committed);
}

export async function relocateSharedFilesBeforePlaylistRemoval(
  playlistType: string,
  options: { downloadRoot?: string | null } = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const safePlaylistType = String(playlistType || "").trim();
  if (!safePlaylistType) return { relocated: 0 };

  const removedDir = path.resolve(downloadRoot, AURRAL_FLOWS_DIR, safePlaylistType);
  const byPath = new Map<string, DownloadJob[]>();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string") continue;
    if (String(job.playlistType || "") === safePlaylistType) continue;
    const finalPath = path.resolve(job.finalPath);
    if (!isPathInsideRoot(finalPath, removedDir)) continue;
    if (!(await fileExists(finalPath))) continue;
    const list = byPath.get(finalPath) || [];
    list.push(job);
    byPath.set(finalPath, list);
  }

  let relocated = 0;
  for (const [oldPath, jobs] of byPath) {
    const [survivor] = sortReusableJobs(jobs);
    if (!survivor) continue;
    const nextPath = await adoptFileIntoPlaylist(oldPath, survivor.playlistType, downloadRoot, {
      track: survivor,
    });
    if (nextPath) relocated += 1;
  }
  return { relocated };
}

export async function removePlaylistFileIfUnshared(
  finalPath: string | null | undefined,
  playlistId: string,
  options: { downloadRoot?: string | null; excludeJobIds?: string[] | null } = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId || typeof finalPath !== "string" || !isFlowPlaylistType(safePlaylistId)) {
    return { action: "skipped" };
  }
  const resolved = path.resolve(finalPath);
  if (!isPathInsideRoot(resolved, path.resolve(downloadRoot, AURRAL_FLOWS_DIR, safePlaylistId))) {
    return { action: "skipped" };
  }

  const excludeJobIds = new Set(
    (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const matchingJobs = downloadTracker
    .getAll()
    .filter(
      (job) =>
        job?.status === "done" &&
        typeof job.finalPath === "string" &&
        path.resolve(job.finalPath) === resolved,
    );
  if (matchingJobs.some((job) => job.externalPath)) return { action: "skipped" };
  const others = matchingJobs.filter((job) => !excludeJobIds.has(String(job.id || "")));
  const [survivor] = sortReusableJobs(others);
  if (survivor) {
    const nextPath = await adoptFileIntoPlaylist(resolved, survivor.playlistType, downloadRoot);
    return { action: nextPath ? "relocated" : "skipped" };
  }
  await fs.rm(resolved, { force: true });
  return { action: "deleted" };
}

function findMatchingArtist(artists: ReadArtist[], track: DownloadTrackInput) {
  const artistMbid = String(track?.artistMbid || "").trim();
  if (artistMbid) {
    const match = artists.find(
      (artist) =>
        String(artist?.mbid || "").trim() === artistMbid ||
        String(artist?.foreignArtistId || "").trim() === artistMbid,
    );
    if (match) return match;
  }
  const artistKey = normalizeText(track?.artistName);
  if (!artistKey) return null;
  return (
    artists.find((artist) => normalizeText(artist?.artistName || artist?.name) === artistKey) ||
    null
  );
}

const albumHasMbid = (album: ReadAlbum, albumMbid: string) =>
  [album.mbid, album.foreignAlbumId, album.releaseGroupMbid].some(
    (value) => String(value || "").trim() === albumMbid,
  );

function rankAlbums(albums: ReadAlbum[], track: DownloadTrackInput) {
  const albumMbid = String(track?.albumMbid || "").trim();
  const albumKey = normalizeText(track?.albumName);
  return [...albums].sort((left, right) => {
    const score = (album: ReadAlbum) => {
      let total = 0;
      if (albumMbid && albumHasMbid(album, albumMbid)) total += 100;
      if (albumKey && normalizeText(album?.albumName || album?.title) === albumKey) {
        total += 50;
      }
      if (album?.statistics?.sizeOnDisk > 0) total += 5;
      return total;
    };
    return score(right) - score(left);
  });
}

function findMatchingTrack(tracks: ReadTrack[], track: DownloadTrackInput, strictAlbum = false) {
  const trackMbid = String(track?.trackMbid || "").trim();
  if (trackMbid) {
    const match = tracks.find(
      (entry) =>
        String(entry?.mbid || "").trim() === trackMbid ||
        String(entry?.foreignTrackId || "").trim() === trackMbid,
    );
    if (match) return match;
    if (strictAlbum) return null;
  }
  const trackKey = normalizeText(track?.trackName);
  if (!trackKey) return null;
  return (
    tracks.find((entry) => normalizeText(entry?.trackName || entry?.title) === trackKey) || null
  );
}

const FOLDER_SOURCES = {
  aurral: { label: "Library", external: false, mapPath: (filePath: string) => filePath },
  lidarr: {
    label: "Lidarr",
    external: true,
    mapPath: (filePath: string) => resolveLocalPath(filePath, getPathMappings("lidarr")),
  },
  readonly: { label: "Read-only folder", external: true, mapPath: (filePath: string) => filePath },
};

// Indexed files stay where they are, so a playlist uses the file in place.
async function findLibraryFolderSource(
  track: DownloadTrackInput,
  options: SourceOptions = {},
  source: FolderSource = "lidarr",
): Promise<ReuseSource | null> {
  const { label, external, mapPath } = FOLDER_SOURCES[source];
  const strictAlbum = options.targetPlaylistType === "library";
  const { artists, albums, tracks } = buildLibraryReadModel(
    getLibraryForArtistReferences({
      source,
      availableOnly: false,
      references: [track?.artistMbid, track?.artistName],
    }),
  );
  const artist =
    findLibraryArtist(artists, track?.artistMbid) || findMatchingArtist(artists, track);
  if (!artist) {
    console.log(
      `[FileReuse] ${label}: no artist match for "${track?.artistName}" (mbid ${track?.artistMbid || "none"}, ${artists.length} artists checked)`,
    );
    return null;
  }
  const artistId = artist.id;
  if (!artistId) return null;

  const artistAlbums = albums.filter((album) => String(album.artistId) === String(artist.id));
  if (!artistAlbums.length) {
    console.log(
      `[FileReuse] ${label}: artist "${artist.artistName}" (id ${artistId}) matched but has 0 albums`,
    );
    return null;
  }

  let foundTitleOnAnyAlbum = false;
  const rankedAlbums = rankAlbums(artistAlbums, track);
  const albumsToCheck = strictAlbum
    ? rankedAlbums.filter((album) => {
        const albumMbid = String(track?.albumMbid || "").trim();
        if (albumMbid) return albumHasMbid(album, albumMbid);
        const albumName = normalizeText(track?.albumName);
        return !albumName || normalizeText(album?.albumName || album?.title) === albumName;
      })
    : rankedAlbums;
  for (const album of albumsToCheck) {
    const albumTracks = findLibraryTracksForAlbum(tracks, album.id);
    const matchedTrack = findMatchingTrack(albumTracks, track, strictAlbum);
    if (!matchedTrack) continue;
    foundTitleOnAnyAlbum = true;
    if (matchedTrack.hasFile !== true || !matchedTrack.path) {
      console.log(
        `[FileReuse] ${label}: "${track.trackName}" found on album "${album.albumName}" (id ${album.id}) but hasFile=${matchedTrack.hasFile} path=${matchedTrack.path || "none"}`,
      );
      continue;
    }
    const sourcePath = path.resolve(mapPath(matchedTrack.path));
    if (!(await fileExists(sourcePath))) {
      console.warn(
        `[FileReuse] ${label} track exists but file is not accessible from Aurral: ${matchedTrack.path} (resolved to ${sourcePath})`,
      );
      continue;
    }
    return {
      sourceType: source,
      sourcePath,
      ...(external && { externalPath: matchedTrack.path }),
      albumName: album.albumName || track.albumName || null,
    };
  }
  if (!foundTitleOnAnyAlbum) {
    console.log(
      `[FileReuse] ${label}: artist "${artist.artistName}" matched (${artistAlbums.length} albums checked) but no album's tracklist contained "${track.trackName}"`,
    );
  }
  return null;
}

async function findFolderSource(
  track: DownloadTrackInput,
  options: SourceOptions,
): Promise<ReuseSource | null> {
  if (options.allowLidarr === false) return null;
  const { lidarrClient } = await import("../lidarrClient.ts");
  return (
    (await findLibraryFolderSource(track, options, "aurral")) ||
    (lidarrClient.isConfigured()
      ? await findLibraryFolderSource(track, options, "lidarr")
      : null) ||
    findLibraryFolderSource(track, options, "readonly")
  );
}

/**
 * Resolves a reusable track source from local storage, Aurral library, or Lidarr library.
 *
 * @param {object} track - Track metadata to locate.
 * @param {object} [options={}] - Reuse options including targetPlaylistType.
 * @returns {Promise<{source: object|null, reason: string|null}>}
 */
export async function resolveReusableTrackSource(
  track: DownloadTrackInput,
  options: SourceOptions = {},
) {
  const localSource = await findLocalExistingSource(track, options);
  if (localSource) return { source: localSource, reason: null };

  const aurralSource = await findAurralSource(track, options);
  if (aurralSource) return { source: aurralSource, reason: null };
  const folderSource = await findFolderSource(track, options);
  if (folderSource) return { source: folderSource, reason: null };
  return { source: null, reason: "No reusable Aurral, Lidarr, or read-only folder file found" };
}

/**
 * Resolves a repair source for a track, checking local storage, Lidarr, and Aurral library.
 *
 * @param {object} track - Track metadata to locate for repair.
 * @param {object} [options={}] - Repair options including targetPlaylistType.
 * @returns {Promise<{source: object|null, reason: string|null}>}
 */
export async function resolveRepairTrackSource(
  track: DownloadTrackInput,
  options: SourceOptions = {},
) {
  const localSource = await findLocalExistingSource(track, options);
  if (localSource) return { source: localSource, reason: null };

  const folderSource = await findFolderSource(track, options);
  if (folderSource) return { source: folderSource, reason: null };
  const aurralSource = await findAurralSource(track, options);
  if (aurralSource) return { source: aurralSource, reason: null };
  return { source: null, reason: "No reusable Aurral, Lidarr, or read-only folder file found" };
}

export async function restoreCompletedTrack(job: DownloadJob, options: RestoreOptions = {}) {
  if (!job || job.status !== "done" || !job.finalPath) {
    return { action: "skipped", reason: "Track is not completed" };
  }

  const finalPath = path.resolve(job.finalPath);
  if (await fileExists(finalPath)) {
    return { action: "ok", reason: "Playlist file exists" };
  }

  const resolveSource = options.resolveSource || resolveRepairTrackSource;
  const { source, reason } = await resolveSource(job, {
    ...options,
    targetPlaylistType: job.playlistType,
    excludeJobIds: [job.id],
    allowLidarr: options.allowLidarr ?? !job.requestGroupId,
  });
  if (source) {
    const sourcePath = path.resolve(source.sourcePath);
    if (await fileExists(sourcePath)) {
      if (finalPath === sourcePath) {
        return { action: "ok", reason: "Already using source path" };
      }
      downloadTracker.setDone(
        job.id,
        sourcePath,
        source.albumName || job.albumName || null,
        source.externalPath || null,
        { reusedLibraryFile: noPlaylistDownloadedFile(sourcePath, job.id) },
      );
      console.log(
        `[FileReuse] Repaired ${job.playlistType} path from ${source.sourceType}: ${job.artistName} - ${job.trackName}`,
      );
      return {
        action: "repaired",
        sourceType: source.sourceType,
        sourcePath,
        finalPath: sourcePath,
      };
    }
  }

  if (options.requeueOnMissing === false) {
    return {
      action: "skipped",
      reason: reason || "No reusable source found",
    };
  }

  const requeued = downloadTracker.setPending(job.id, "Track file is missing");
  if (!requeued) {
    return { action: "skipped", reason: "Failed to requeue track" };
  }
  console.log(
    `[FileReuse] Requeued missing track for ${job.playlistType}: ${job.artistName} - ${job.trackName}`,
  );
  return {
    action: "requeued",
    reason: reason || "No reusable source found",
  };
}

const isWithinFolder = (folder: string, filePath: string) =>
  filePath === path.resolve(folder) || isPathInsideRoot(filePath, path.resolve(folder));

// A download that reused a file outside the Library folder needs Aurral's
// own copy once that file's folder leaves the Library.
export function requeueJobsUsingRemovedFolders({
  downloadRoot = resolveDownloadRoot(),
  removedFolders = [],
  keptFolders = [],
  externalFiles = false,
  reason,
}: RemovedFolderRequeue = {}) {
  const root = path.resolve(downloadRoot);
  let requeued = 0;
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string" || job.managedBy === "lidarr")
      continue;
    const finalPath = path.resolve(job.finalPath);
    if (isPathInsideRoot(finalPath, root)) continue;
    if (keptFolders.some((folder) => isWithinFolder(folder, finalPath))) continue;
    const removed =
      removedFolders.some((folder) => isWithinFolder(folder, finalPath)) ||
      (externalFiles && Boolean(job.externalPath));
    if (removed && downloadTracker.setPending(job.id, reason)) requeued += 1;
  }
  return requeued;
}

export async function repairJobsUnderRemovedPlaylistDir(
  playlistType: string,
  options: RestoreOptions = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const safePlaylistType = String(playlistType || "").trim();
  if (!safePlaylistType) {
    return { repaired: 0, requeued: 0, skipped: 0, changedPlaylistTypes: [] };
  }

  const removedDir = path.resolve(downloadRoot, AURRAL_FLOWS_DIR, safePlaylistType);
  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  const changedPlaylistTypes = new Set<string>();

  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job?.finalPath !== "string") continue;
    const finalPath = path.resolve(job.finalPath);
    if (!isPathInsideRoot(finalPath, removedDir)) continue;
    if (await fileExists(finalPath)) continue;

    const result = await restoreCompletedTrack(job, {
      ...options,
      downloadRoot,
      requeueOnMissing: true,
    });
    if (result.action === "repaired") {
      repaired += 1;
      changedPlaylistTypes.add(String(job.playlistType || ""));
    } else if (result.action === "requeued") {
      requeued += 1;
      changedPlaylistTypes.add(String(job.playlistType || ""));
    } else if (downloadTracker.setPending(job.id, "Source playlist was removed")) {
      requeued += 1;
      changedPlaylistTypes.add(String(job.playlistType || ""));
    } else {
      skipped += 1;
    }
  }

  if (repaired > 0 || requeued > 0) {
    const { playlistManager } = await import("../playlists/playlistManager.ts");
    playlistManager.requestPlaylistSync([...changedPlaylistTypes]);
    if (changedPlaylistTypes.has("library")) playlistManager.scheduleScanLibrary();
  }

  return {
    repaired,
    requeued,
    skipped,
    changedPlaylistTypes: [...changedPlaylistTypes],
  };
}

function parsePlaylistIdFromFinalPath(finalPath: string) {
  const marker = `${path.sep}${AURRAL_FLOWS_DIR}${path.sep}`;
  const markerIndex = finalPath.indexOf(marker);
  if (markerIndex < 0) return null;
  return finalPath.slice(markerIndex + marker.length).split(path.sep)[0] || null;
}

export async function repairOrphanedPlaylistTrackPaths(options: RestoreOptions = {}) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const { flowPlaylistConfig } = await import("../playlists/flowPlaylistConfig.ts");
  const activeIds = new Set([
    ...flowPlaylistConfig.getFlows().map((flow: { id: string }) => String(flow.id)),
    ...flowPlaylistConfig
      .getStaticPlaylists()
      .map((playlist: { id: string }) => String(playlist.id)),
  ]);

  const removedIds = new Set<string>();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job?.finalPath !== "string") continue;
    const finalPath = path.resolve(job.finalPath);
    if (await fileExists(finalPath)) continue;
    const ownerId = parsePlaylistIdFromFinalPath(finalPath);
    if (!ownerId || activeIds.has(ownerId)) continue;
    removedIds.add(ownerId);
  }

  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  for (const removedId of removedIds) {
    const result = await repairJobsUnderRemovedPlaylistDir(removedId, {
      ...options,
      downloadRoot,
    });
    repaired += result.repaired;
    requeued += result.requeued;
    skipped += result.skipped;
  }

  return { repaired, requeued, skipped, removedIds: [...removedIds] };
}

const REUSE_REPAIR_BATCH_SIZE = 50;

export async function repairReusableTrackLinks(
  options: RestoreOptions & { batchSize?: number; cursor?: number } = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const jobs = downloadTracker
    .getAll()
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const batchSize = Math.max(1, Math.floor(Number(options.batchSize) || REUSE_REPAIR_BATCH_SIZE));
  const cursor = Math.max(0, Math.floor(Number(options.cursor) || 0));
  const sortedJobs = [...jobs].sort((left, right) =>
    String(left?.id || "").localeCompare(String(right?.id || "")),
  );
  const batch = [];
  if (sortedJobs.length > 0) {
    for (let index = 0; index < batchSize; index += 1) {
      const job = sortedJobs[(cursor + index) % sortedJobs.length];
      if (job) batch.push(job);
    }
  }

  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  let failures = 0;
  const changedPlaylistTypes = new Set<string>();
  for (const job of batch) {
    try {
      const result = await restoreCompletedTrack(job, {
        ...options,
        downloadRoot,
        requeueOnMissing: true,
      });
      if (result.action === "repaired") {
        repaired += 1;
        if (job?.playlistType) {
          changedPlaylistTypes.add(String(job.playlistType));
        }
      } else if (result.action === "requeued") {
        requeued += 1;
        if (job?.playlistType) {
          changedPlaylistTypes.add(String(job.playlistType));
        }
      } else {
        skipped += 1;
      }
    } catch (error) {
      failures += 1;
      console.warn(
        `[FileReuse] Failed to repair ${job?.id || "unknown"}: ${asAppError(error)?.message || error}`,
      );
    }
  }

  const nextCursor = sortedJobs.length === 0 ? 0 : (cursor + batch.length) % sortedJobs.length;
  if (repaired > 0 || requeued > 0) {
    console.log(
      `[FileReuse] Track health sweep repaired ${repaired}, requeued ${requeued} of ${batch.length} checked tracks`,
    );
    const { playlistManager } = await import("../playlists/playlistManager.ts");
    playlistManager.requestPlaylistSync([...changedPlaylistTypes]);
    if (changedPlaylistTypes.has("library")) playlistManager.scheduleScanLibrary();
    if (requeued > 0) {
      const [{ downloadWorker }, { restartWorkerIfPending }] = await Promise.all([
        import("./downloadWorker.ts"),
        import("./mutationGuards.ts"),
      ]);
      await restartWorkerIfPending();
      if (downloadWorker.running) {
        downloadWorker.wake();
      }
    }
  }
  return {
    scanned: batch.length,
    repaired,
    requeued,
    skipped,
    failures,
    nextCursor,
    total: sortedJobs.length,
  };
}

const handedOverAurralPathsStmt = db
  .prepare<[], string>(`
  SELECT media.path
  FROM library_media_files AS media
  JOIN library_albums AS album ON album.id = media.album_id
  JOIN library_management AS management
    ON management.entity_kind = 'album' AND management.entity_id = album.id
  WHERE media.source = 'aurral'
    AND media.available = 1
    AND management.managed_by = 'lidarr'
    AND json_valid(album.metadata_json)
    AND json_extract(album.metadata_json, '$.aurralHandoverAt') IS NOT NULL
`)
  .pluck();

export async function moveHandedOverTracksToLidarr() {
  const handedOver = new Set(
    handedOverAurralPathsStmt.all().map((filePath) => path.resolve(filePath)),
  );
  if (handedOver.size === 0) return { moved: 0, deleted: 0 };

  const jobsByPath = new Map<string, DownloadJob[]>();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string") continue;
    const current = path.resolve(job.finalPath);
    if (handedOver.has(current)) jobsByPath.set(current, [...(jobsByPath.get(current) || []), job]);
  }

  const movedPaths: string[] = [];
  const changedPlaylistTypes = new Set<string>();
  let moved = 0;
  for (const [oldPath, jobs] of jobsByPath) {
    const [first] = jobs;
    if (!first) continue;
    const source = await findLibraryFolderSource(first, { targetPlaylistType: "library" });
    if (!source || !(await fileExists(source.sourcePath))) continue;
    for (const job of jobs) {
      downloadTracker.setDone(
        job.id,
        path.resolve(source.sourcePath),
        source.albumName || job.albumName || null,
        source.externalPath || null,
      );
      if (job.playlistType) changedPlaylistTypes.add(String(job.playlistType));
    }
    moved += jobs.length;
    movedPaths.push(oldPath);
  }
  if (movedPaths.length === 0) return { moved: 0, deleted: 0 };

  const { playlistManager } = await import("../playlists/playlistManager.ts");
  playlistManager.requestPlaylistSync([...changedPlaylistTypes]);
  for (const oldPath of movedPaths) await fs.rm(oldPath, { force: true });
  const deleted = movedPaths.length;
  scheduleLibraryScanJob({ includeLidarr: false, changedPaths: movedPaths });
  console.log(
    `[FileReuse] Moved ${moved} tracks onto Lidarr files and removed ${deleted} Aurral copies`,
  );
  return { moved, deleted };
}

async function refreshPlaylistAfterReuse(
  playlistTypes: string[],
  shouldScheduleLibraryScan = false,
  changedPaths: string[] | null = null,
) {
  const { playlistManager } = await import("../playlists/playlistManager.ts");
  playlistManager.requestPlaylistSync([...new Set(playlistTypes)]);
  if (!shouldScheduleLibraryScan) return;
  if (Array.isArray(changedPaths)) {
    scheduleLibraryScanJob({ includeLidarr: false, changedPaths });
  } else {
    playlistManager.scheduleScanLibrary();
  }
}

export async function reuseTrackForPlaylist(
  track: DownloadTrackInput,
  playlistType: string,
  options: ReuseTrackOptions = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const targetPlaylistType = String(options.targetPlaylistType || playlistType || "").trim();
  if (targetPlaylistType === "library") {
    const excluded = new Set(
      (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    );
    const activeSource = sortReusableJobs([
      ...downloadTracker.getByStatus("pending"),
      ...downloadTracker.getByStatus("downloading"),
    ]).find(
      (job) =>
        !excluded.has(String(job.id || "")) &&
        job.playlistType !== "library" &&
        tracksShareLibraryMembership(track, job),
    );
    if (activeSource) {
      return {
        reused: false,
        deferred: true,
        sourceJobId: activeSource.id,
        reason: "Waiting for an existing acquisition",
      };
    }
  }
  const { source, reason } = await resolveReusableTrackSource(track, {
    ...options,
    downloadRoot,
    targetPlaylistType,
  });
  if (!source) return { reused: false, reason };

  const finalPath =
    source.sourceType === "aurral" && targetPlaylistType === "library"
      ? (await adoptFileIntoPlaylist(source.sourcePath, targetPlaylistType, downloadRoot, {
          track,
        }))!
      : path.resolve(source.sourcePath);
  if (!(await fileExists(finalPath))) {
    return { reused: false, reason: "Source file is missing" };
  }

  const jobId = options.existingJobId || downloadTracker.addJob(track, playlistType);
  if (!jobId) {
    return { reused: false, reason: "Failed to create reuse job" };
  }
  downloadTracker.setDone(
    jobId,
    finalPath,
    source.albumName || track.albumName || null,
    source.externalPath || null,
    { reusedLibraryFile: noPlaylistDownloadedFile(finalPath, jobId) },
  );
  console.log(
    `[FileReuse] Reused ${source.sourceType} track for ${playlistType}: ${track.artistName} - ${track.trackName}`,
  );
  if (!options.skipHistory && source.sourceType !== "lidarr") {
    import("../aurralHistoryService.ts")
      .then(({ recordTrackReused }) =>
        recordTrackReused({
          track,
          playlistId: playlistType,
          sourceType: source.sourceType,
        }),
      )
      .catch(() => {});
  }
  const movedFrom = finalPath === path.resolve(source.sourcePath) ? [] : downloadTracker.getAll();
  refreshPlaylistAfterReuse(
    [
      playlistType,
      ...movedFrom.filter((job) => job.finalPath === finalPath).map((job) => job.playlistType),
      ...flowPlaylistConfig.getStaticPlaylistIdsUsingJobs([jobId]),
    ],
    targetPlaylistType === "library",
    options.libraryScanChangedPaths || (options.allowLidarr === false ? [finalPath] : null),
  ).catch((error) => {
    console.warn(
      `[FileReuse] Failed to refresh playlist ${playlistType}: ${asAppError(error)?.message || error}`,
    );
  });
  return {
    reused: true,
    jobId,
    sourceType: source.sourceType,
    sourcePath: finalPath,
    finalPath,
    albumName: source.albumName || track.albumName || null,
  };
}
