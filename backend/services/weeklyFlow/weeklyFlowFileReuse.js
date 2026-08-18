import fs from "fs/promises";
import path from "path";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import {
  flowPlaylistConfig,
  tracksShareMembership,
} from "./weeklyFlowPlaylistConfig.js";
import { libraryManager } from "../libraryManager.js";
import { commitImportToPlaylistLibrary, sanitizePathPart } from "../playlistDownloadUtils.js";
import {
  AURRAL_FLOWS_DIR,
  isPathInsideRoot,
  PLAYLIST_LIBRARY_DIR,
  remapLegacyPath as remapLegacyWeeklyFlowPath,
  resolvePlaylistRoot as resolveWeeklyFlowRoot,
} from "../playlistPaths.js";
import { getPathMappings, resolveLocalPath } from "../pathMappings.js";

export const EXISTING_FILE_MODES = new Set(["download", "reuse"]);
const LEGACY_REUSE_MODES = new Set(["hardlink", "copy"]);
const DEFAULT_EXISTING_FILE_MODE = "reuse";

export function normalizeExistingFileMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (EXISTING_FILE_MODES.has(normalized)) {
    return normalized;
  }
  if (LEGACY_REUSE_MODES.has(normalized)) {
    return "reuse";
  }
  return DEFAULT_EXISTING_FILE_MODE;
}

export function sortJobsForTrackReuse(jobs) {
  return [...jobs].sort((a, b) => {
    const priority = (job) => {
      if (job?.status === "done") return 0;
      if (job?.status === "failed") return 1;
      if (job?.status === "downloading") return 2;
      if (job?.status === "pending") return 3;
      return 4;
    };
    const priorityDiff = priority(a) - priority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
  });
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

function isFlowPlaylistType(playlistType) {
  return Boolean(flowPlaylistConfig.getFlow(String(playlistType || "").trim()));
}

function tracksShareLibraryMembership(left, right) {
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

async function findAurralSource(track, options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const targetPlaylistType = String(options.targetPlaylistType || "").trim();
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
    const matches = targetPlaylistType === "library"
      ? tracksShareLibraryMembership(track, job)
      : tracksShareMembership(track, job);
    if (!matches) continue;
    if (targetPlaylistType && String(job.playlistType || "") === targetPlaylistType) {
      continue;
    }
    const sourcePath = remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot);
    if (!(await fileExists(sourcePath))) continue;
    candidates.push(job);
  }
  const staticJobs = candidates.filter((job) => !isFlowPlaylistType(job.playlistType));
  const flowJobs = candidates.filter((job) => isFlowPlaylistType(job.playlistType));
  const sourceJob = sortReusableJobs(staticJobs)[0] || sortReusableJobs(flowJobs)[0];
  if (!sourceJob) return null;
  return {
    sourceType: "aurral",
    sourcePath: path.resolve(remapLegacyWeeklyFlowPath(sourceJob.finalPath, weeklyFlowRoot)),
    sourceJob,
    albumName: sourceJob.albumName || track.albumName || null,
  };
}

function retargetJobsToPath(oldPath, newPath, weeklyFlowRoot, albumName = null) {
  const resolvedOld = path.resolve(oldPath);
  const resolvedNew = path.resolve(newPath);
  if (resolvedOld === resolvedNew) return;
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string") continue;
    const current = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    if (current !== resolvedOld) continue;
    downloadTracker.setDone(
      job.id,
      resolvedNew,
      albumName || job.albumName || null,
      job.externalPath || null,
    );
  }
}

export async function adoptFileIntoPlaylist(sourcePath, targetPlaylistType, weeklyFlowRoot, options = {}) {
  const safeTarget = String(targetPlaylistType || "").trim();
  const root = path.resolve(weeklyFlowRoot || resolveWeeklyFlowRoot());
  const resolvedSource = path.resolve(remapLegacyWeeklyFlowPath(sourcePath, root));
  if (!safeTarget || !(await fileExists(resolvedSource))) return null;

  const knownFlow = isFlowPlaylistType(safeTarget);
  const knownPlaylist = Boolean(flowPlaylistConfig.getSharedPlaylist(safeTarget));
  const canonical = knownFlow || knownPlaylist;
  const ephemeral = knownFlow;
  const targetRoot = ephemeral
    ? path.resolve(root, AURRAL_FLOWS_DIR, safeTarget)
    : canonical
      ? path.resolve(root)
      : path.resolve(root, PLAYLIST_LIBRARY_DIR, safeTarget);
  const legacySource = [PLAYLIST_LIBRARY_DIR, AURRAL_FLOWS_DIR].some((directory) =>
    isPathInsideRoot(resolvedSource, path.resolve(root, directory)),
  );
  if (
    (ephemeral && isPathInsideRoot(resolvedSource, targetRoot)) ||
    (!ephemeral && !canonical && isPathInsideRoot(resolvedSource, targetRoot)) ||
    (!ephemeral && canonical && !legacySource)
  ) {
    return resolvedSource;
  }

  const sourcePlaylistId = parsePlaylistIdFromFinalPath(resolvedSource, root);
  const sourceRoot = sourcePlaylistId
    ? path.resolve(
        root,
        resolvedSource.includes(`${path.sep}${AURRAL_FLOWS_DIR}${path.sep}`)
          ? AURRAL_FLOWS_DIR
          : PLAYLIST_LIBRARY_DIR,
        sourcePlaylistId,
      )
    : null;
  const relative =
    sourceRoot && isPathInsideRoot(resolvedSource, sourceRoot)
      ? path.relative(sourceRoot, resolvedSource)
      : path.basename(resolvedSource);
  const segments = relative.split(path.sep).filter(Boolean);
  const artistDir = sanitizePathPart(options.track?.artistName || segments.at(-3), "Unknown Artist");
  const albumDir = sanitizePathPart(options.track?.albumName || segments.at(-2), "Unknown Album");
  const fileName = path.basename(resolvedSource);
  const destPath = canonical
    ? path.join(targetRoot, artistDir, albumDir, fileName)
    : path.join(targetRoot, relative);
  const committed = await commitImportToPlaylistLibrary(resolvedSource, destPath);
  retargetJobsToPath(resolvedSource, committed, root);
  return path.resolve(committed);
}

export async function relocateSharedFilesBeforePlaylistRemoval(playlistType, options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const safePlaylistType = String(playlistType || "").trim();
  if (!safePlaylistType) return { relocated: 0 };

  const removedDirs = [
    path.resolve(weeklyFlowRoot, PLAYLIST_LIBRARY_DIR, safePlaylistType),
    path.resolve(weeklyFlowRoot, AURRAL_FLOWS_DIR, safePlaylistType),
  ];
  const byPath = new Map();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job.finalPath !== "string") continue;
    if (String(job.playlistType || "") === safePlaylistType) continue;
    const finalPath = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    if (!removedDirs.some((removedDir) => isPathInsideRoot(finalPath, removedDir))) continue;
    if (!(await fileExists(finalPath))) continue;
    const list = byPath.get(finalPath) || [];
    list.push(job);
    byPath.set(finalPath, list);
  }

  let relocated = 0;
  for (const [oldPath, jobs] of byPath) {
    const survivor = sortReusableJobs(jobs)[0];
    const nextPath = await adoptFileIntoPlaylist(
      oldPath,
      survivor.playlistType,
      weeklyFlowRoot,
      { track: survivor },
    );
    if (nextPath) relocated += 1;
  }
  return { relocated };
}

export async function removePlaylistFileIfUnshared(finalPath, playlistId, options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId || typeof finalPath !== "string") return { action: "skipped" };

  const playlistRoots = isFlowPlaylistType(safePlaylistId)
    ? [path.resolve(weeklyFlowRoot, AURRAL_FLOWS_DIR, safePlaylistId)]
    : flowPlaylistConfig.getSharedPlaylist(safePlaylistId)
      ? [path.resolve(weeklyFlowRoot)]
      : [path.resolve(weeklyFlowRoot, PLAYLIST_LIBRARY_DIR, safePlaylistId)];
  if (flowPlaylistConfig.getSharedPlaylist(safePlaylistId)) return { action: "skipped" };
  const resolved = path.resolve(remapLegacyWeeklyFlowPath(finalPath, weeklyFlowRoot));
  if (!playlistRoots.some((playlistRoot) => isPathInsideRoot(resolved, playlistRoot))) {
    return { action: "skipped" };
  }

  const excludeJobIds = new Set(
    (Array.isArray(options.excludeJobIds) ? options.excludeJobIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const others = [];
  for (const job of downloadTracker.getAll()) {
    if (!job || job.status !== "done" || typeof job.finalPath !== "string") continue;
    if (excludeJobIds.has(String(job.id || ""))) continue;
    const current = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    if (current === resolved) others.push(job);
  }
  if (others.length > 0) {
    const survivor = sortReusableJobs(others)[0];
    const nextPath = await adoptFileIntoPlaylist(
      resolved,
      survivor.playlistType,
      weeklyFlowRoot,
    );
    return { action: nextPath ? "relocated" : "skipped" };
  }
  await fs.rm(resolved, { force: true });
  return { action: "deleted" };
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

function findMatchingTrack(tracks, track, strictAlbum = false) {
  const trackMbid = String(track?.trackMbid || "").trim();
  if (trackMbid) {
    const match = tracks.find(
      (entry) =>
        String(entry?.mbid || "").trim() === trackMbid ||
        String(entry?.foreignRecordingId || "").trim() === trackMbid ||
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

async function findLidarrSource(track, options = {}) {
  const strictAlbum = options.targetPlaylistType === "library";
  let artists = [];
  try {
    artists = await libraryManager.getAllArtists();
  } catch (error) {
    console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr artists:", error.message);
    return null;
  }
  const artist = findMatchingArtist(Array.isArray(artists) ? artists : [], track);
  if (!artist) {
    console.log(
      `[WeeklyFlowReuse] Lidarr: no artist match for "${track?.artistName}" (mbid ${track?.artistMbid || "none"}, ${artists.length} Lidarr artists checked)`,
    );
    return null;
  }
  const artistId = artist.id || artist.artistId;
  if (!artistId) return null;

  let albums = [];
  try {
    albums = await libraryManager.getAlbums(artistId);
  } catch (error) {
    console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr albums:", error.message);
    return null;
  }
  if (!albums.length) {
    console.log(
      `[WeeklyFlowReuse] Lidarr: artist "${artist.artistName}" (id ${artistId}) matched but has 0 albums`,
    );
    return null;
  }

  let foundTitleOnAnyAlbum = false;
  const rankedAlbums = rankAlbums(Array.isArray(albums) ? albums : [], track);
  const albumsToCheck = strictAlbum
    ? rankedAlbums.filter((album) => {
        const albumMbid = String(track?.albumMbid || "").trim();
        if (albumMbid) {
          return (
            String(album?.mbid || "").trim() === albumMbid ||
            String(album?.foreignAlbumId || "").trim() === albumMbid
          );
        }
        const albumName = normalizeText(track?.albumName);
        return !albumName || normalizeText(album?.albumName || album?.title) === albumName;
      })
    : rankedAlbums;
  for (const album of albumsToCheck) {
    let tracks = [];
    try {
      tracks = await libraryManager.getTracks(album.id);
    } catch (error) {
      console.warn("[WeeklyFlowReuse] Failed to inspect Lidarr tracks:", error.message);
      continue;
    }
    const matchedTrack = findMatchingTrack(
      Array.isArray(tracks) ? tracks : [],
      track,
      strictAlbum,
    );
    if (!matchedTrack) continue;
    foundTitleOnAnyAlbum = true;
    if (matchedTrack.hasFile !== true || !matchedTrack.path) {
      console.log(
        `[WeeklyFlowReuse] Lidarr: "${track.trackName}" found on album "${album.albumName}" (id ${album.id}) but hasFile=${matchedTrack.hasFile} path=${matchedTrack.path || "none"}`,
      );
      continue;
    }
    const sourcePath = path.resolve(resolveLocalPath(matchedTrack.path, getPathMappings("lidarr")));
    if (!(await fileExists(sourcePath))) {
      console.warn(
        `[WeeklyFlowReuse] Lidarr track exists but file is not accessible from Aurral: ${matchedTrack.path} (resolved to ${sourcePath})`,
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
  if (!foundTitleOnAnyAlbum) {
    console.log(
      `[WeeklyFlowReuse] Lidarr: artist "${artist.artistName}" matched (${albums.length} albums checked) but no album's tracklist contained "${track.trackName}"`,
    );
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
  const lidarrSource = await findLidarrSource(track, options);
  if (lidarrSource) return { source: lidarrSource, reason: null };
  return { source: null, reason: "No reusable Aurral or Lidarr file found" };
}

export async function resolveRepairTrackSource(track, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { source: null, reason: "Existing file reuse is disabled" };
  }
  const lidarrSource = await findLidarrSource(track, options);
  if (lidarrSource) return { source: lidarrSource, reason: null };
  const aurralSource = await findAurralSource(track, options);
  if (aurralSource) return { source: aurralSource, reason: null };
  return { source: null, reason: "No reusable Aurral or Lidarr file found" };
}

export async function restoreCompletedTrack(job, options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return { action: "skipped", reason: "Existing file reuse is disabled" };
  }
  if (!job || job.status !== "done" || !job.finalPath) {
    return { action: "skipped", reason: "Track is not completed" };
  }

  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const finalPath = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
  if (await fileExists(finalPath)) {
    return { action: "ok", reason: "Playlist file exists" };
  }

  const resolveSource = options.resolveSource || resolveRepairTrackSource;
  const { source, reason } = await resolveSource(job, {
    ...options,
    existingFileMode: mode,
    targetPlaylistType: job.playlistType,
    excludeJobIds: [job.id],
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
      );
      console.log(
        `[WeeklyFlowReuse] Repaired ${job.playlistType} path from ${source.sourceType}: ${job.artistName} - ${job.trackName}`,
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
    `[WeeklyFlowReuse] Requeued missing track for ${job.playlistType}: ${job.artistName} - ${job.trackName}`,
  );
  return {
    action: "requeued",
    reason: reason || "No reusable source found",
  };
}

export async function repairJobsUnderRemovedPlaylistDir(playlistType, options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const safePlaylistType = String(playlistType || "").trim();
  if (!safePlaylistType) {
    return { repaired: 0, requeued: 0, skipped: 0, changedPlaylistTypes: [] };
  }

  const removedDirs = [
    path.resolve(weeklyFlowRoot, PLAYLIST_LIBRARY_DIR, safePlaylistType),
    path.resolve(weeklyFlowRoot, AURRAL_FLOWS_DIR, safePlaylistType),
  ];
  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  const changedPlaylistTypes = new Set();

  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job?.finalPath !== "string") continue;
    const finalPath = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    if (!removedDirs.some((removedDir) => isPathInsideRoot(finalPath, removedDir))) continue;
    if (await fileExists(finalPath)) continue;

    const result = await restoreCompletedTrack(job, {
      ...options,
      weeklyFlowRoot,
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
    const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
    for (const changedPlaylistType of changedPlaylistTypes) {
      await playlistManager.refreshPlaylist(changedPlaylistType).catch(() => {});
    }
    playlistManager.scheduleScanLibrary();
  }

  return {
    repaired,
    requeued,
    skipped,
    changedPlaylistTypes: [...changedPlaylistTypes],
  };
}

function parsePlaylistIdFromFinalPath(finalPath, weeklyFlowRoot) {
  const resolved = path.resolve(remapLegacyWeeklyFlowPath(finalPath, weeklyFlowRoot));
  for (const directory of [PLAYLIST_LIBRARY_DIR, AURRAL_FLOWS_DIR]) {
    const marker = `${path.sep}${directory}${path.sep}`;
    const markerIndex = resolved.indexOf(marker);
    if (markerIndex < 0) continue;
    const remainder = resolved.slice(markerIndex + marker.length);
    const playlistId = remainder.split(path.sep)[0];
    if (playlistId) return playlistId;
  }
  return null;
}

export async function repairOrphanedPlaylistTrackPaths(options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
  const { flowPlaylistConfig } = await import("./weeklyFlowPlaylistConfig.js");
  const activeIds = new Set([
    ...flowPlaylistConfig.getFlows().map((flow) => String(flow.id)),
    ...flowPlaylistConfig.getSharedPlaylists().map((playlist) => String(playlist.id)),
  ]);

  const removedIds = new Set();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || typeof job?.finalPath !== "string") continue;
    const finalPath = path.resolve(remapLegacyWeeklyFlowPath(job.finalPath, weeklyFlowRoot));
    if (await fileExists(finalPath)) continue;
    const ownerId = parsePlaylistIdFromFinalPath(finalPath, weeklyFlowRoot);
    if (!ownerId || activeIds.has(ownerId)) continue;
    removedIds.add(ownerId);
  }

  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  for (const removedId of removedIds) {
    const result = await repairJobsUnderRemovedPlaylistDir(removedId, {
      ...options,
      weeklyFlowRoot,
    });
    repaired += result.repaired;
    requeued += result.requeued;
    skipped += result.skipped;
  }

  return { repaired, requeued, skipped, removedIds: [...removedIds] };
}

const REUSE_REPAIR_BATCH_SIZE = 50;

export async function repairReusableTrackLinks(options = {}) {
  const mode = normalizeExistingFileMode(options.existingFileMode);
  if (mode === "download") {
    return {
      scanned: 0,
      repaired: 0,
      requeued: 0,
      skipped: 0,
      failures: 0,
      nextCursor: 0,
    };
  }

  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
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
      batch.push(sortedJobs[(cursor + index) % sortedJobs.length]);
    }
  }

  let repaired = 0;
  let requeued = 0;
  let skipped = 0;
  let failures = 0;
  const changedPlaylistTypes = new Set();
  for (const job of batch) {
    try {
      const result = await restoreCompletedTrack(job, {
        ...options,
        existingFileMode: mode,
        weeklyFlowRoot,
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
        `[WeeklyFlowReuse] Failed to repair ${job?.id || "unknown"}: ${error?.message || error}`,
      );
    }
  }

  const nextCursor = sortedJobs.length === 0 ? 0 : (cursor + batch.length) % sortedJobs.length;
  if (repaired > 0 || requeued > 0) {
    console.log(
      `[WeeklyFlowReuse] Track health sweep repaired ${repaired}, requeued ${requeued} of ${batch.length} checked tracks`,
    );
    const { playlistManager } = await import("./weeklyFlowPlaylistManager.js");
    for (const playlistType of changedPlaylistTypes) {
      await playlistManager.refreshPlaylist(playlistType).catch(() => {});
    }
    playlistManager.scheduleScanLibrary();
    if (requeued > 0) {
      const [{ weeklyFlowWorker }, { restartWorkerIfPending }] = await Promise.all([
        import("./weeklyFlowWorker.js"),
        import("./weeklyFlowMutationGuards.js"),
      ]);
      await restartWorkerIfPending();
      if (weeklyFlowWorker.running) {
        weeklyFlowWorker.wake();
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
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolveWeeklyFlowRoot());
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
    import("../aurralHistoryService.js")
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
