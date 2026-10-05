import fs from "fs/promises";
import path from "path";
import { setTimeout as sleep } from "node:timers/promises";
import { lidarrClient } from "./lidarrClient.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { moveJobsToLidarrFile } from "./downloadJobs/fileReuse.js";
import { remapLegacyPath, resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveRemotePath } from "./pathMappings.js";
import { logger } from "./logger.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const ALBUM_READY_ATTEMPTS = 8;
const FINISHED_COMMAND_STATUSES = new Set(["completed", "failed", "aborted", "cancelled", "orphaned"]);
const inflightImports = new Map();

function importError(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
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

const pathKey = (value) => String(value || "").replace(/\\/g, "/").toLowerCase();

function remoteDirname(remotePath) {
  const normalized = String(remotePath).replace(/\\/g, "/");
  return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

function rejectionText(rejections) {
  return (Array.isArray(rejections) ? rejections : [])
    .map((rejection) => String(rejection?.reason || rejection || "").trim())
    .filter(Boolean);
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function finishedTrackJobs({ trackMbid, artistName, trackName } = {}) {
  const mbid = String(trackMbid || "").trim();
  const artistKey = normalizeText(artistName);
  const trackKey = normalizeText(trackName);
  const matches = downloadTracker.getAll().filter((job) =>
    job?.status === "done" && job.finalPath && !job.externalPath &&
    (mbid
      ? job.trackMbid === mbid
      : artistKey && trackKey && normalizeText(job.artistName) === artistKey &&
        normalizeText(job.trackName) === trackKey));
  return [
    ...matches.filter((job) => job.playlistType === "library"),
    ...matches.filter((job) => job.playlistType !== "library"),
  ];
}

function findImportableJob(reference = {}, canAccessJob = null) {
  const id = String(reference.jobId || "").trim();
  if (id) return downloadTracker.getJob(id);
  return finishedTrackJobs(reference).find((job) => !canAccessJob || canAccessJob(job)) || null;
}

/**
 * Finds a finished Aurral job for a track whose file is still on disk.
 *
 * @param {{trackMbid?: string, artistName?: string, trackName?: string}} track
 * @param {{downloadRoot?: string, canAccessJob?: function}} [options={}]
 * @returns {Promise<object|null>}
 */
export async function findFinishedTrackJob(track, options = {}) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  for (const job of finishedTrackJobs(track)) {
    if (options.canAccessJob && !options.canAccessJob(job)) continue;
    if (await fileExists(path.resolve(remapLegacyPath(job.finalPath, downloadRoot)))) return job;
  }
  return null;
}

function matchAlbumTrack(tracks, job) {
  const trackMbid = String(job.trackMbid || "").trim();
  if (trackMbid) {
    const match = tracks.find((track) => String(track?.foreignRecordingId || "").trim() === trackMbid);
    if (match) return match;
  }
  const titleKey = normalizeText(job.trackName);
  const byTitle = tracks.filter((track) => titleKey && normalizeText(track?.title) === titleKey);
  const durationMs = Number(job.durationMs);
  if (byTitle.length < 2 || !Number.isFinite(durationMs) || durationMs <= 0) return byTitle[0] || null;
  return [...byTitle].sort((left, right) =>
    Math.abs(Number(left.duration || 0) - durationMs) - Math.abs(Number(right.duration || 0) - durationMs))[0];
}

async function ensureLidarrArtist(job) {
  const artistMbid = String(job.artistMbid || "").trim();
  if (!artistMbid) throw importError(422, "The track has no MusicBrainz artist ID, so Lidarr can't match it");
  const existing = await lidarrClient.getArtistByMbid(artistMbid);
  if (existing?.id) return existing;
  try {
    // Monitor nothing so adding the artist never starts downloads of other albums.
    return await lidarrClient.addArtist(artistMbid, job.artistName, {
      albumOnly: true,
      monitorOption: "none",
      triggerSearch: false,
    });
  } catch (error) {
    const added = await lidarrClient.getArtistByMbid(artistMbid, { forceRefresh: true }).catch(() => null);
    if (added?.id) return added;
    throw error;
  }
}

async function ensureLidarrAlbum(artist, albumMbid, job, wait) {
  let addError = null;
  for (let attempt = 1; attempt <= ALBUM_READY_ATTEMPTS; attempt += 1) {
    const existing = await lidarrClient.getAlbumByMbid(albumMbid, { forceRefresh: true });
    if (existing?.id) return lidarrClient.getAlbum(existing.id).catch(() => existing);
    try {
      const added = await lidarrClient.addAlbum(artist.id, albumMbid, job.albumName || job.trackName, {
        monitored: false,
        triggerSearch: false,
      });
      if (added?.id) return lidarrClient.getAlbum(added.id).catch(() => added);
    } catch (error) {
      // Lidarr may still be refreshing a newly added artist, or the refresh added the album first.
      addError = error;
    }
    await wait();
  }
  throw importError(502, `Lidarr could not add the album: ${addError?.message || "album not found"}`);
}

const albumTypeRank = (album) => (String(album?.albumType || "").toLowerCase() === "album" ? 0 : 1);

// Flow tracks from Last.fm often lack an album MBID; use the albums Lidarr added with the artist.
async function findArtistAlbum(artist, job, wait) {
  let albums = [];
  for (let attempt = 1; attempt <= ALBUM_READY_ATTEMPTS && albums.length === 0; attempt += 1) {
    albums = await lidarrClient.getAllAlbums({ artistIds: [artist.id], forceRefresh: true });
    if (albums.length === 0) await wait();
  }
  const albumKey = normalizeText(job.albumName);
  let match = albumKey ? albums.find((album) => normalizeText(album?.title) === albumKey) : null;
  if (!match) {
    const ranked = [...albums].sort((left, right) =>
      albumTypeRank(left) - albumTypeRank(right) ||
      String(left?.releaseDate || "9999").localeCompare(String(right?.releaseDate || "9999")));
    for (const album of ranked) {
      if (matchAlbumTrack(await lidarrClient.getTracksByAlbumId(album.id), job)) {
        match = album;
        break;
      }
    }
  }
  return match ? lidarrClient.getAlbum(match.id).catch(() => match) : null;
}

async function waitForAlbumTracks(albumId, wait) {
  for (let attempt = 1; attempt <= ALBUM_READY_ATTEMPTS; attempt += 1) {
    const tracks = await lidarrClient.getTracksByAlbumId(albumId);
    if (tracks.length > 0) return tracks;
    await wait();
  }
  return [];
}

function selectRelease(album) {
  const releases = Array.isArray(album?.releases) ? album.releases : [];
  return releases.find((release) => release?.monitored) || releases[0] || null;
}

async function resolveImportItem({ job, candidate, artistId, album, albumTracks }) {
  const albumId = album.id;
  const ownTrackIds = (item) => (Array.isArray(item?.tracks) ? item.tracks : [])
    .map((track) => track?.id)
    .filter((id) => Number.isInteger(id) && id > 0);
  if (candidate.album?.id === albumId && ownTrackIds(candidate).length > 0) {
    return {
      albumReleaseId: candidate.albumReleaseId || selectRelease(album)?.id || 0,
      trackIds: ownTrackIds(candidate),
    };
  }

  const releaseId = selectRelease(album)?.id || 0;
  // Ask Lidarr to re-identify the file against this album, like its own manual import UI does.
  const reidentified = await lidarrClient.request("/manualimport", "POST", [{
    id: candidate.id,
    path: candidate.path,
    name: candidate.name,
    artistId,
    albumId,
    albumReleaseId: releaseId,
    quality: candidate.quality,
    releaseGroup: candidate.releaseGroup,
    indexerFlags: candidate.indexerFlags || 0,
    downloadId: candidate.downloadId,
    additionalFile: candidate.additionalFile === true,
    replaceExistingFiles: false,
    disableReleaseSwitching: true,
  }]).catch((error) => {
    logger.warn("library", "Lidarr could not re-identify the track for import", { message: error.message });
    return [];
  });
  const item = (Array.isArray(reidentified) ? reidentified : [])
    .find((entry) => pathKey(entry?.path) === pathKey(candidate.path));
  if (ownTrackIds(item).length > 0) {
    return { albumReleaseId: item.albumReleaseId || releaseId, trackIds: ownTrackIds(item) };
  }

  const match = matchAlbumTrack(albumTracks, job);
  if (!match?.id) return null;
  return { albumReleaseId: match.albumReleaseId || releaseId, trackIds: [match.id] };
}

async function waitForCommand(command, { pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let current = command;
  while (!FINISHED_COMMAND_STATUSES.has(String(current?.status || "").toLowerCase())) {
    if (Date.now() > deadline) throw importError(504, "Timed out waiting for Lidarr to import the track");
    await sleep(pollIntervalMs);
    current = await lidarrClient.request(`/command/${command.id}`);
  }
  return current;
}

async function findManualImportCandidate(remotePath, artistId = null) {
  const query = new URLSearchParams({
    folder: remoteDirname(remotePath),
    ...(artistId ? { artistId: String(artistId) } : {}),
    filterExistingFiles: "false",
    replaceExistingFiles: "false",
  });
  const candidates = await lidarrClient.request(`/manualimport?${query}`);
  return (Array.isArray(candidates) ? candidates : [])
    .find((entry) => pathKey(entry?.path) === pathKey(remotePath)) || null;
}

async function runImport(job, options) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = () => sleep(pollIntervalMs);
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const localPath = path.resolve(remapLegacyPath(job.finalPath, downloadRoot));
  if (!(await fileExists(localPath))) throw importError(404, "The track's file is missing");

  const remotePath = resolveRemotePath(localPath, getPathMappings("lidarr"));
  // Check that Lidarr can reach the file before adding anything to Lidarr.
  if (!(await findManualImportCandidate(remotePath))) {
    throw importError(422, `Lidarr can't see the file at ${remotePath}. Check the Lidarr path mapping.`);
  }

  const albumMbid = String(job.albumMbid || "").trim();
  const artist = await ensureLidarrArtist(job);
  const album = albumMbid
    ? await ensureLidarrAlbum(artist, albumMbid, job, wait)
    : await findArtistAlbum(artist, job, wait);
  if (!album) throw importError(422, "No Lidarr album of this artist contains the track");
  const artistId = album.artistId || artist.id;
  const albumTracks = await waitForAlbumTracks(album.id, wait);

  const candidate = await findManualImportCandidate(remotePath, artistId);
  if (!candidate) {
    throw importError(422, `Lidarr can't see the file at ${remotePath}. Check the Lidarr path mapping.`);
  }
  const rejections = rejectionText(candidate.rejections);
  const resolved = await resolveImportItem({ job, candidate, artistId, album, albumTracks });
  if (!resolved) {
    throw importError(422, "No matching track in the Lidarr album", { rejections });
  }

  const command = await lidarrClient.request("/command", "POST", {
    name: "ManualImport",
    files: [{
      path: candidate.path,
      artistId,
      albumId: album.id,
      albumReleaseId: resolved.albumReleaseId,
      trackIds: resolved.trackIds,
      quality: candidate.quality,
      releaseGroup: candidate.releaseGroup,
      indexerFlags: candidate.indexerFlags || 0,
      downloadId: candidate.downloadId,
      disableReleaseSwitching: true,
    }],
    importMode: "move",
    replaceExistingFiles: false,
  });
  const finished = await waitForCommand(command, { pollIntervalMs, timeoutMs });
  if (String(finished?.status || "").toLowerCase() !== "completed") {
    throw importError(502, `Lidarr import ${finished?.status || "failed"}: ${finished?.message || "no details"}`, {
      rejections,
    });
  }

  const importedTrack = (await lidarrClient.getTracksByAlbumId(album.id))
    .find((track) => resolved.trackIds.includes(track?.id) && Number(track.trackFileId) > 0);
  const trackFile = importedTrack
    ? (await lidarrClient.getTrackFilesByAlbumId(album.id))
      .find((file) => file?.id === importedTrack.trackFileId)
    : null;
  if (!trackFile?.path) {
    throw importError(502, "Lidarr did not import the track", { rejections });
  }

  const { libraryManager } = await import("./libraryManager.js");
  await libraryManager.recordLidarrTrackImport(artist, album);
  const { moved, finalPath } = await moveJobsToLidarrFile(localPath, trackFile.path, {
    downloadRoot,
    albumName: album.title,
  });
  logger.info("library", "Imported track into Lidarr", {
    jobId: job.id,
    lidarrAlbumId: album.id,
    jobsUpdated: moved,
  });
  return { success: true, lidarrAlbumId: album.id, trackFile: trackFile.path, finalPath, jobsUpdated: moved };
}

/**
 * Hands a downloaded Aurral track to Lidarr, which moves the file into its root folder.
 *
 * @param {{jobId?: string, trackMbid?: string, artistName?: string, trackName?: string}} reference
 * @param {object} [options={}] - canAccessJob filter plus downloadRoot, pollIntervalMs and timeoutMs overrides.
 */
export async function importTrackToLidarr(reference, options = {}) {
  if (!lidarrClient.isConfigured()) throw importError(400, "Lidarr is not configured");
  const job = findImportableJob(reference, options.canAccessJob);
  if (!job || options.canAccessJob?.(job) === false) throw importError(404, "Download not found");
  if (job.status !== "done" || !job.finalPath) throw importError(409, "The track hasn't finished downloading");
  if (job.externalPath) throw importError(409, "The track is already in Lidarr");

  const key = path.resolve(job.finalPath);
  const inflight = inflightImports.get(key);
  if (inflight) return inflight;
  const request = runImport(job, options).finally(() => inflightImports.delete(key));
  inflightImports.set(key, request);
  return request;
}
