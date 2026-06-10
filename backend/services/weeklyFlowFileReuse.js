import fs from "fs/promises";
import path from "path";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { buildSharedTrackIdentity } from "./weeklyFlowPlaylistConfig.js";
import { libraryManager } from "./libraryManager.js";
import {
  remapLegacyWeeklyFlowPath,
  resolveWeeklyFlowRoot,
} from "./weeklyFlowPaths.js";

export const EXISTING_FILE_MODES = new Set(["download", "hardlink", "copy"]);
const DEFAULT_EXISTING_FILE_MODE = "hardlink";
const LINK_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
]);
let crossDeviceReuseHintLogged = false;
const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".aac",
  ".opus",
  ".alac",
  ".ape",
  ".wma",
]);

export function normalizeExistingFileMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return EXISTING_FILE_MODES.has(normalized)
    ? normalized
    : DEFAULT_EXISTING_FILE_MODE;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePathPart(value, fallback = "Unknown") {
  const sanitized = String(value || fallback)
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return sanitized || fallback;
}

function isPathInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function getPlaylistRoot(weeklyFlowRoot, playlistType) {
  return path.resolve(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    String(playlistType || "").trim(),
  );
}

function getAudioExtension(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) ? ext : ".mp3";
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function logCrossDeviceReuseHint() {
  if (crossDeviceReuseHintLogged) return;
  crossDeviceReuseHintLogged = true;
  console.warn(
    "[WeeklyFlowReuse] Lidarr and the flow library are on different mount points, so hardlinks are unavailable and copies will be used instead. Mount /data into the container and set DOWNLOAD_FOLDER to the absolute in-container path (for example /data/downloads/tmp) so flow files are written on the same mount as Lidarr.",
  );
}

export async function pathsShareDevice(leftPath, rightPath) {
  try {
    const [leftStat, rightStat] = await Promise.all([
      fs.stat(path.dirname(path.resolve(leftPath))),
      fs.stat(path.dirname(path.resolve(rightPath))),
    ]);
    return leftStat.dev === rightStat.dev;
  } catch {
    return false;
  }
}

async function getUniqueTargetPath(targetPath) {
  let candidate = path.resolve(targetPath);
  const parsed = path.parse(candidate);
  let suffix = 1;
  while (await fileExists(candidate)) {
    candidate = path.resolve(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function sortReusableJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const leftCreated = Number(left?.createdAt || 0);
    const rightCreated = Number(right?.createdAt || 0);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}

async function findAurralSource(track, options = {}) {
  const weeklyFlowRoot = path.resolve(
    options.weeklyFlowRoot || resolveWeeklyFlowRoot(),
  );
  const targetPlaylistType = String(options.targetPlaylistType || "").trim();
  const identity = buildSharedTrackIdentity(track);
  const excludeJobIds = new Set(
    (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const candidates = [];
  for (const job of downloadTracker.getAll()) {
    if (!job || job.status !== "done") continue;
    if (excludeJobIds.has(String(job.id || ""))) continue;
    if (!job.finalPath || typeof job.finalPath !== "string") continue;
    if (buildSharedTrackIdentity(job) !== identity) continue;
    const sourcePath = remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot);
    if (!isPathInsideRoot(sourcePath, path.resolve(weeklyFlowRoot))) continue;
    if (targetPlaylistType && String(job.playlistType || "") === targetPlaylistType) {
      const targetRoot = getPlaylistRoot(weeklyFlowRoot, targetPlaylistType);
      if (isPathInsideRoot(sourcePath, targetRoot)) continue;
    }
    if (!(await fileExists(sourcePath))) continue;
    candidates.push(job);
  }
  const sourceJob = sortReusableJobs(candidates)[0];
  if (!sourceJob) return null;
  return {
    sourceType: "aurral",
    sourcePath: path.resolve(sourceJob.finalPath),
    sourceJob,
    albumName: sourceJob.albumName || track.albumName || null,
  };
}

function findMatchingArtist(artists, track) {
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

function rankAlbums(albums, track) {
  const albumMbid = String(track?.albumMbid || "").trim();
  const albumKey = normalizeText(track?.albumName);
  return [...albums].sort((left, right) => {
    const score = (album) => {
      let total = 0;
      if (
        albumMbid &&
        (String(album?.mbid || "").trim() === albumMbid ||
          String(album?.foreignAlbumId || "").trim() === albumMbid)
      ) {
        total += 100;
      }
      if (albumKey && normalizeText(album?.albumName || album?.title) === albumKey) {
        total += 50;
      }
      if (album?.statistics?.sizeOnDisk > 0) total += 5;
      return total;
    };
    return score(right) - score(left);
  });
}

function findMatchingTrack(tracks, track) {
  const trackMbid = String(track?.trackMbid || "").trim();
  if (trackMbid) {
    const match = tracks.find(
      (entry) =>
        String(entry?.mbid || "").trim() === trackMbid ||
        String(entry?.foreignRecordingId || "").trim() === trackMbid ||
        String(entry?.foreignTrackId || "").trim() === trackMbid,
    );
    if (match) return match;
  }
  const trackKey = normalizeText(track?.trackName);
  if (!trackKey) return null;
  return (
    tracks.find((entry) => normalizeText(entry?.trackName || entry?.title) === trackKey) ||
    null
  );
}

async function findLidarrSource(track) {
  let artists = [];
  try {
    artists = await libraryManager.getAllArtists();
  } catch (error) {
    console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr artists:", error.message);
    return null;
  }
  const artist = findMatchingArtist(Array.isArray(artists) ? artists : [], track);
  if (!artist) return null;
  const artistId = artist.id || artist.artistId;
  if (!artistId) return null;

  let albums = [];
  try {
    albums = await libraryManager.getAlbums(artistId);
  } catch (error) {
    console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr albums:", error.message);
    return null;
  }

  for (const album of rankAlbums(Array.isArray(albums) ? albums : [], track)) {
    let tracks = [];
    try {
      tracks = await libraryManager.getTracks(album.id);
    } catch (error) {
      console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr tracks:", error.message);
      continue;
    }
    const matchedTrack = findMatchingTrack(Array.isArray(tracks) ? tracks : [], track);
    if (!matchedTrack || matchedTrack.hasFile !== true || !matchedTrack.path) continue;
    const sourcePath = path.resolve(matchedTrack.path);
    if (!(await fileExists(sourcePath))) {
      console.warn(
        `[WeeklyFlowReuse] Lidarr track exists but file is not accessible from Aurral: ${matchedTrack.path}`,
      );
      continue;
    }
    return {
      sourceType: "lidarr",
      sourcePath,
      lidarrTrack: matchedTrack,
      albumName: album.albumName || track.albumName || null,
    };
  }
  return null;
}

function buildTargetPathForSource(source, track, playlistType, weeklyFlowRoot) {
  const targetRoot = getPlaylistRoot(weeklyFlowRoot, playlistType);
  if (source?.sourceType === "aurral" && source.sourceJob) {
    const sourceRoot = getPlaylistRoot(weeklyFlowRoot, source.sourceJob.playlistType);
    const sourcePath = path.resolve(source.sourcePath);
    if (isPathInsideRoot(sourcePath, sourceRoot)) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      return path.resolve(targetRoot, relativePath);
    }
  }

  const artistDir = sanitizePathPart(track?.artistName, "Unknown Artist");
  const albumDir = sanitizePathPart(source?.albumName || track?.albumName, "Unknown Album");
  const fileName = `${sanitizePathPart(track?.trackName, "Unknown Track")}${getAudioExtension(source?.sourcePath)}`;
  return path.resolve(targetRoot, artistDir, albumDir, fileName);
}

export async function createPlaylistFileEntry(sourcePath, targetPath, mode = "hardlink") {
  const normalizedMode = normalizeExistingFileMode(mode);
  if (normalizedMode === "download") {
    return { linked: false, reason: "Existing file reuse is disabled" };
  }
  const safeSourcePath = path.resolve(sourcePath);
  const safeTargetPath = path.resolve(targetPath);
  await fs.mkdir(path.dirname(safeTargetPath), { recursive: true });

  if (normalizedMode === "hardlink") {
    const sharedDevice = await pathsShareDevice(safeSourcePath, safeTargetPath);
    if (!sharedDevice) {
      logCrossDeviceReuseHint();
    } else {
      try {
        await fs.link(safeSourcePath, safeTargetPath);
        return { linked: true, linkType: "hardlink" };
      } catch (error) {
        if (!LINK_FALLBACK_CODES.has(error?.code)) {
          return { linked: false, reason: error.message };
        }
        if (error?.code === "EXDEV") {
          logCrossDeviceReuseHint();
        } else {
          console.warn(
            `[WeeklyFlowReuse] Hardlink failed, copying file instead: ${error.code} ${error.message}`,
          );
        }
      }
    }
  }

  try {
    await fs.copyFile(safeSourcePath, safeTargetPath);
    return { linked: true, linkType: "copy" };
  } catch (error) {
    return { linked: false, reason: error.message };
  }
}

export async function resolveReusableTrackSource(track, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { source: null, reason: "Existing file reuse is disabled" };
  }
  const aurralSource = await findAurralSource(track, options);
  if (aurralSource) return { source: aurralSource, reason: null };
  const lidarrSource = await findLidarrSource(track);
  if (lidarrSource) return { source: lidarrSource, reason: null };
  return { source: null, reason: "No reusable Aurral or Lidarr file found" };
}

export async function resolveRepairTrackSource(track, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { source: null, reason: "Existing file reuse is disabled" };
  }
  const lidarrSource = await findLidarrSource(track);
  if (lidarrSource) return { source: lidarrSource, reason: null };
  const aurralSource = await findAurralSource(track, options);
  if (aurralSource) return { source: aurralSource, reason: null };
  return { source: null, reason: "No reusable Aurral or Lidarr file found" };
}

async function getFileInode(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.ino : null;
  } catch {
    return null;
  }
}

export async function repairCompletedTrackLink(job, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { repaired: false, reason: "Existing file reuse is disabled" };
  }
  if (!job || job.status !== "done" || !job.finalPath) {
    return { repaired: false, reason: "Track is not completed" };
  }

  const finalPath = path.resolve(job.finalPath);
  if (!(await fileExists(finalPath))) {
    return { repaired: false, reason: "Playlist file is missing" };
  }

  const resolveSource = options.resolveSource || resolveRepairTrackSource;
  const { source, reason } = await resolveSource(job, {
    ...options,
    existingFileMode: mode,
    targetPlaylistType: job.playlistType,
    excludeJobIds: [job.id],
  });
  if (!source) {
    return { repaired: false, reason: reason || "No reusable source found" };
  }

  const sourcePath = path.resolve(source.sourcePath);
  if (finalPath === sourcePath) {
    return { repaired: false, reason: "Already using source path" };
  }

  const [finalInode, sourceInode] = await Promise.all([
    getFileInode(finalPath),
    getFileInode(sourcePath),
  ]);
  if (
    finalInode != null &&
    sourceInode != null &&
    finalInode === sourceInode
  ) {
    return { repaired: false, reason: "Already linked to reusable source" };
  }

  const deviceCheck = options.deviceCheck || pathsShareDevice;
  if (mode === "hardlink" && !(await deviceCheck(sourcePath, finalPath))) {
    return {
      repaired: false,
      reason: "Hardlink unavailable across filesystems",
    };
  }

  try {
    await fs.unlink(finalPath);
  } catch (error) {
    return {
      repaired: false,
      reason: error?.message || "Failed to remove existing playlist file",
    };
  }

  const link = await createPlaylistFileEntry(sourcePath, finalPath, mode);
  if (!link.linked) {
    await createPlaylistFileEntry(sourcePath, finalPath, "copy").catch(() => {});
    return {
      repaired: false,
      reason: link.reason || "Failed to relink reusable source",
    };
  }

  downloadTracker.setDone(
    job.id,
    finalPath,
    source.albumName || job.albumName || null,
  );
  console.log(
    `[WeeklyFlowReuse] Repaired ${job.playlistType} via ${link.linkType} from ${source.sourceType}: ${job.artistName} - ${job.trackName}`,
  );
  return {
    repaired: true,
    sourceType: source.sourceType,
    linkType: link.linkType,
    sourcePath,
    finalPath,
  };
}

const REUSE_REPAIR_BATCH_SIZE = 50;

export async function repairReusableTrackLinks(options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return {
      scanned: 0,
      repaired: 0,
      skipped: 0,
      failures: 0,
      nextCursor: 0,
    };
  }

  const weeklyFlowRoot = path.resolve(
    options.weeklyFlowRoot || resolveWeeklyFlowRoot(),
  );
  const jobs = downloadTracker
    .getAll()
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const batchSize = Math.max(
    1,
    Math.floor(Number(options.batchSize) || REUSE_REPAIR_BATCH_SIZE),
  );
  const cursor = Math.max(0, Math.floor(Number(options.cursor) || 0));
  const sortedJobs = [...jobs].sort((left, right) =>
    String(left?.id || "").localeCompare(String(right?.id || "")),
  );
  const batch = [];
  if (sortedJobs.length > 0) {
    for (let index = 0; index < batchSize; index += 1) {
      batch.push(sortedJobs[(cursor + index) % sortedJobs.length]);
    }
  }

  let repaired = 0;
  let skipped = 0;
  let failures = 0;
  for (const job of batch) {
    try {
      const result = await repairCompletedTrackLink(job, {
        ...options,
        existingFileMode: mode,
        weeklyFlowRoot,
      });
      if (result.repaired) {
        repaired += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failures += 1;
      console.warn(
        `[WeeklyFlowReuse] Failed to repair ${job?.id || "unknown"}: ${error?.message || error}`,
      );
    }
  }

  const nextCursor =
    sortedJobs.length === 0 ? 0 : (cursor + batch.length) % sortedJobs.length;
  if (repaired > 0) {
    console.log(
      `[WeeklyFlowReuse] Link repair sweep repaired ${repaired} of ${batch.length} checked tracks`,
    );
  }
  return {
    scanned: batch.length,
    repaired,
    skipped,
    failures,
    nextCursor,
    total: sortedJobs.length,
  };
}

export async function reuseTrackForPlaylist(track, playlistType, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  const weeklyFlowRoot = path.resolve(
    options.weeklyFlowRoot || resolveWeeklyFlowRoot(),
  );
  if (mode === "download") {
    return { reused: false, reason: "Existing file reuse is disabled" };
  }
  const { source, reason } = await resolveReusableTrackSource(track, {
    ...options,
    existingFileMode: mode,
    weeklyFlowRoot,
    targetPlaylistType: playlistType,
  });
  if (!source) return { reused: false, reason };

  const rawTargetPath = buildTargetPathForSource(
    source,
    track,
    playlistType,
    weeklyFlowRoot,
  );
  const targetRoot = getPlaylistRoot(weeklyFlowRoot, playlistType);
  const targetPath = await getUniqueTargetPath(rawTargetPath);
  if (!isPathInsideRoot(targetPath, targetRoot)) {
    return { reused: false, reason: "Target path is outside playlist root" };
  }
  const link = await createPlaylistFileEntry(source.sourcePath, targetPath, mode);
  if (!link.linked) {
    console.warn(
      `[WeeklyFlowReuse] Existing file reuse unavailable, falling back to download: ${link.reason}`,
    );
    return { reused: false, reason: link.reason };
  }

  const jobId = options.existingJobId || downloadTracker.addJob(track, playlistType);
  if (!jobId) {
    await fs.rm(targetPath, { force: true }).catch(() => {});
    return { reused: false, reason: "Failed to create reuse job" };
  }
  downloadTracker.setDone(jobId, targetPath, source.albumName || track.albumName || null);
  console.log(
    `[WeeklyFlowReuse] Reused ${source.sourceType} track via ${link.linkType} for ${playlistType}: ${track.artistName} - ${track.trackName}`,
  );
  return {
    reused: true,
    jobId,
    sourceType: source.sourceType,
    linkType: link.linkType,
    sourcePath: source.sourcePath,
    finalPath: targetPath,
    albumName: source.albumName || track.albumName || null,
  };
}
