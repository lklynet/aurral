import fs from "fs/promises";
import path from "path";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { buildSharedTrackIdentity } from "./weeklyFlowPlaylistConfig.js";
import { libraryManager } from "./libraryManager.js";
import {
  remapLegacyWeeklyFlowPath,
  resolveWeeklyFlowRoot,
} from "./weeklyFlowPaths.js";
import { resolveLocalPath } from "./pathMappings.js";

export const EXISTING_FILE_MODES = new Set(["download", "reuse"]);
const LEGACY_REUSE_MODES = new Set(["hardlink", "copy"]);
const DEFAULT_EXISTING_FILE_MODE = "reuse";

export function normalizeExistingFileMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (EXISTING_FILE_MODES.has(normalized)) {
    return normalized;
  }
  if (LEGACY_REUSE_MODES.has(normalized)) {
    return "reuse";
  }
  return DEFAULT_EXISTING_FILE_MODE;
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

async function statFilesystemLocation(targetPath) {
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

export async function pathsShareDevice(leftPath, rightPath) {
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

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
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
    if (
      targetPlaylistType &&
      String(job.playlistType || "") === targetPlaylistType
    ) {
      continue;
    }
    const sourcePath = remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot);
    if (!(await fileExists(sourcePath))) continue;
    candidates.push(job);
  }
  const sourceJob = sortReusableJobs(candidates)[0];
  if (!sourceJob) return null;
  return {
    sourceType: "aurral",
    sourcePath: path.resolve(remapLegacyWeeklyFlowPath(sourceJob.finalPath, weeklyFlowRoot)),
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
    const sourcePath = path.resolve(resolveLocalPath(matchedTrack.path));
    if (!(await fileExists(sourcePath))) {
      console.warn(
        `[WeeklyFlowReuse] Lidarr track exists but file is not accessible from Aurral: ${matchedTrack.path}`,
      );
      continue;
    }
    return {
      sourceType: "lidarr",
      sourcePath,
      externalPath: matchedTrack.path,
      lidarrTrack: matchedTrack,
      albumName: album.albumName || track.albumName || null,
    };
  }
  return null;
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

export async function repairCompletedTrackLink(job, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { repaired: false, reason: "Existing file reuse is disabled" };
  }
  if (!job || job.status !== "done" || !job.finalPath) {
    return { repaired: false, reason: "Track is not completed" };
  }

  const weeklyFlowRoot = path.resolve(
    options.weeklyFlowRoot || resolveWeeklyFlowRoot(),
  );
  const finalPath = path.resolve(
    remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot),
  );
  if (await fileExists(finalPath)) {
    return { repaired: false, reason: "Playlist file exists" };
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
  if (!(await fileExists(sourcePath))) {
    return { repaired: false, reason: "Source file is missing" };
  }
  if (finalPath === sourcePath) {
    return { repaired: false, reason: "Already using source path" };
  }

  downloadTracker.setDone(
    job.id,
    sourcePath,
    source.albumName || job.albumName || null,
    source.externalPath || null,
  );
  console.log(
    `[WeeklyFlowReuse] Repaired ${job.playlistType} path from ${source.sourceType}: ${job.artistName} - ${job.trackName}`,
  );
  return {
    repaired: true,
    sourceType: source.sourceType,
    sourcePath,
    finalPath: sourcePath,
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
      `[WeeklyFlowReuse] Path repair sweep repaired ${repaired} of ${batch.length} checked tracks`,
    );
    const playlistTypes = new Set(
      batch
        .filter((job) => job?.playlistType)
        .map((job) => String(job.playlistType)),
    );
    const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
    for (const playlistType of playlistTypes) {
      await playlistManager.refreshPlaylist(playlistType).catch(() => {});
    }
    playlistManager.scheduleScanLibrary();
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

async function refreshPlaylistAfterReuse(playlistType) {
  const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
  await playlistManager.refreshPlaylist(playlistType);
  playlistManager.scheduleScanLibrary();
}

export async function reuseTrackForPlaylist(track, playlistType, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { reused: false, reason: "Existing file reuse is disabled" };
  }
  const weeklyFlowRoot = path.resolve(
    options.weeklyFlowRoot || resolveWeeklyFlowRoot(),
  );
  const { source, reason } = await resolveReusableTrackSource(track, {
    ...options,
    existingFileMode: mode,
    weeklyFlowRoot,
    targetPlaylistType: playlistType,
  });
  if (!source) return { reused: false, reason };

  const finalPath = path.resolve(source.sourcePath);
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
  );
  console.log(
    `[WeeklyFlowReuse] Reused ${source.sourceType} track for ${playlistType}: ${track.artistName} - ${track.trackName}`,
  );
  if (!options.skipHistory && source.sourceType !== "lidarr") {
    import("./aurralHistoryService.js")
      .then(({ recordTrackReused }) =>
        recordTrackReused({
          track,
          playlistId: playlistType,
          sourceType: source.sourceType,
        }),
      )
      .catch(() => {});
  }
  refreshPlaylistAfterReuse(playlistType).catch((error) => {
    console.warn(
      `[WeeklyFlowReuse] Failed to refresh playlist ${playlistType}: ${error?.message || error}`,
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
