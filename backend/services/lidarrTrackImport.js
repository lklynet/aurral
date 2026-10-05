import fs from "fs/promises";
import path from "path";
import { setTimeout as sleep } from "node:timers/promises";
import { lidarrClient } from "./lidarrClient.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { moveJobsToLidarrFile } from "./downloadJobs/fileReuse.js";
import { remapLegacyPath, resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveRemotePath } from "./pathMappings.js";
import { logger } from "./logger.js";
import { dbOps } from "../db/helpers/index.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Lidarr can take minutes to load a newly added artist's albums and tracks.
const LIDARR_WAIT_TIMEOUT_MS = 120 * 1000;
// A ManualImport still running after the request timeout is followed in the background this long.
const BACKGROUND_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
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

// Without a recording MBID, artist and title alone could pick the same song from another album.
function albumMatches(job, albumMbid, albumKey) {
  const jobAlbumMbid = String(job.albumMbid || "").trim();
  if (albumMbid && jobAlbumMbid) return jobAlbumMbid === albumMbid;
  const jobAlbumKey = normalizeText(job.albumName);
  if (albumKey && jobAlbumKey) return jobAlbumKey === albumKey;
  return true;
}

function finishedTrackJobs({ trackMbid, artistName, trackName, albumMbid, albumName } = {}) {
  const mbid = String(trackMbid || "").trim();
  const artistKey = normalizeText(artistName);
  const trackKey = normalizeText(trackName);
  const albumMbidKey = String(albumMbid || "").trim();
  const albumKey = normalizeText(albumName);
  const matches = downloadTracker.getAll().filter((job) =>
    job?.status === "done" && job.finalPath && !job.externalPath &&
    (mbid
      ? job.trackMbid === mbid
      : artistKey && trackKey && normalizeText(job.artistName) === artistKey &&
        normalizeText(job.trackName) === trackKey && albumMatches(job, albumMbidKey, albumKey)));
  return [
    ...matches.filter((job) => job.playlistType === "library"),
    ...matches.filter((job) => job.playlistType !== "library"),
  ];
}

/**
 * Finds a finished Aurral job for a track whose file is still on disk.
 *
 * @param {{trackMbid?: string, artistName?: string, trackName?: string, albumMbid?: string, albumName?: string}} track
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

/**
 * Polls until read() returns a value or the budget runs out. Past half the budget it calls
 * onHalfway once, so a stalled Lidarr artist refresh can be restarted.
 */
async function pollUntil(read, { budgetMs, pollIntervalMs, onHalfway }) {
  const startedAt = Date.now();
  let nudged = false;
  while (true) {
    const value = await read();
    if (value) return value;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= budgetMs) return null;
    if (!nudged && elapsed >= budgetMs / 2) {
      nudged = true;
      await onHalfway?.();
    }
    await sleep(pollIntervalMs);
  }
}

async function ensureLidarrAlbum(artist, albumMbid, job, waiter) {
  let addError = null;
  const album = await pollUntil(async () => {
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
    return null;
  }, waiter);
  if (album) return album;
  throw importError(502, `Lidarr could not add the album: ${addError?.message || "album not found"}`);
}

const albumTypeRank = (album) => (String(album?.albumType || "").toLowerCase() === "album" ? 0 : 1);

// Flow tracks from Last.fm often lack an album MBID; use the albums Lidarr added with the artist.
async function findArtistAlbum(artist, job, waiter) {
  const albums = (await pollUntil(async () => {
    const found = await lidarrClient.getAllAlbums({ artistIds: [artist.id], forceRefresh: true });
    return found.length > 0 ? found : null;
  }, waiter)) || [];
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

async function waitForAlbumTracks(albumId, waiter) {
  return (await pollUntil(async () => {
    const tracks = await lidarrClient.getTracksByAlbumId(albumId);
    return tracks.length > 0 ? tracks : null;
  }, waiter)) || [];
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
  if (match?.id) return { albumReleaseId: match.albumReleaseId || releaseId, trackIds: [match.id] };

  const release = (album.releases || []).find((entry) => entry?.id === releaseId);
  logger.warn("library", "Lidarr import found no matching track", {
    job: { trackMbid: job.trackMbid, trackName: job.trackName, albumMbid: job.albumMbid, albumName: job.albumName },
    album: { id: album.id, title: album.title, foreignAlbumId: album.foreignAlbumId, albumType: album.albumType },
    release: { id: releaseId, trackCount: release?.trackCount ?? null },
    albumTracks: albumTracks.length,
    sampleTracks: albumTracks.slice(0, 5).map((track) => [track?.title, track?.foreignRecordingId]),
    candidate: { albumId: candidate.album?.id ?? null, albumReleaseId: candidate.albumReleaseId ?? null,
      tracks: ownTrackIds(candidate).length },
    reidentified: item
      ? { albumId: item.album?.id ?? null, albumReleaseId: item.albumReleaseId ?? null, tracks: ownTrackIds(item).length }
      : null,
    rejections: rejectionText(item?.rejections ?? candidate.rejections),
  });
  return null;
}

// Resolves to the finished command, or null if it is still running when the time is up.
async function waitForCommand(command, { pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let current = command;
  while (!FINISHED_COMMAND_STATUSES.has(String(current?.status || "").toLowerCase())) {
    if (Date.now() > deadline) return null;
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
  const result = await lidarrClient.request(`/manualimport?${query}`);
  const candidates = Array.isArray(result) ? result : [];
  const exact = candidates.find((entry) => entry?.path === remotePath);
  if (exact) return exact;
  // Only trust a case-insensitive match when it can't be confused with another file.
  const loose = candidates.filter((entry) => pathKey(entry?.path) === pathKey(remotePath));
  return loose.length === 1 ? loose[0] : null;
}

async function runImport(job, options) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  let refreshSent = false;
  const waiter = {
    budgetMs: options.lidarrWaitTimeoutMs ?? LIDARR_WAIT_TIMEOUT_MS,
    pollIntervalMs,
    onHalfway: async () => {
      if (refreshSent) return;
      refreshSent = true;
      await lidarrClient.request("/command", "POST", {
        name: "RefreshArtist",
        artistId: artist.id,
        artistIds: [artist.id],
      }).catch((error) => {
        logger.warn("library", "Could not ask Lidarr to refresh the artist", { message: error.message });
      });
    },
  };
  const album = albumMbid
    ? await ensureLidarrAlbum(artist, albumMbid, job, waiter)
    : await findArtistAlbum(artist, job, waiter);
  if (!album) throw importError(422, "No Lidarr album of this artist contains the track");
  const artistId = album.artistId || artist.id;
  const albumTracks = await waitForAlbumTracks(album.id, waiter);

  const candidate = await findManualImportCandidate(remotePath, artistId);
  if (!candidate) {
    throw importError(422, `Lidarr can't see the file at ${remotePath}. Check the Lidarr path mapping.`);
  }
  const rejections = rejectionText(candidate.rejections);
  const resolved = await resolveImportItem({ job, candidate, artistId, album, albumTracks });
  if (!resolved) {
    const year = String(album.releaseDate || "").slice(0, 4);
    throw importError(422, `No matching track in Lidarr album "${album.title}"${year ? ` (${year})` : ""}`, {
      rejections,
    });
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
  const finalize = (finished) => finalizeImport({
    job, finished, artist, album, resolved, rejections, localPath, downloadRoot,
  });
  const finished = await waitForCommand(command, { pollIntervalMs, timeoutMs });
  if (finished) return finalize(finished);

  // Lidarr keeps importing after Aurral stops waiting; follow the file once it finishes.
  const background = waitForCommand(command, {
    pollIntervalMs,
    timeoutMs: options.backgroundTimeoutMs ?? BACKGROUND_COMMAND_TIMEOUT_MS,
  })
    .then((done) => {
      if (!done) throw new Error("Lidarr did not finish the import within an hour");
      return finalize(done);
    })
    .catch((error) => {
      logger.warn("library", "Lidarr import did not finish", { jobId: job.id, message: error.message });
    });
  throw importError(
    202,
    `Lidarr is still importing ${job.trackName || "the track"}; Aurral will follow the file when it finishes`,
    { stillImporting: true, background },
  );
}

async function finalizeImport({ job, finished, artist, album, resolved, rejections, localPath, downloadRoot }) {
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
  // The file has moved either way, so jobs follow it even when Aurral can't read Lidarr's path.
  const { moved, finalPath } = await moveJobsToLidarrFile(localPath, trackFile.path, {
    downloadRoot,
    albumName: album.title,
  });
  const localPathReadable = await fileExists(finalPath);
  if (!localPathReadable) {
    logger.warn("library", "Aurral can't read the track Lidarr imported. Add a lidarr path mapping.", {
      remotePath: trackFile.path,
      localPath: finalPath,
    });
  }
  logger.info("library", "Imported track into Lidarr", {
    jobId: job.id,
    lidarrAlbumId: album.id,
    jobsUpdated: moved,
  });
  return {
    success: true,
    lidarrAlbumId: album.id,
    trackFile: trackFile.path,
    finalPath,
    jobsUpdated: moved,
    localPathReadable,
  };
}

/**
 * Hands a downloaded Aurral track to Lidarr, which moves the file into its root folder.
 *
 * @param {{jobId: string}} reference
 * @param {object} [options={}] - canAccessJob filter plus downloadRoot, pollIntervalMs,
 *   lidarrWaitTimeoutMs, timeoutMs and backgroundTimeoutMs overrides.
 */
export async function importTrackToLidarr({ jobId } = {}, options = {}) {
  if (!lidarrClient.isConfigured()) throw importError(400, "Lidarr is not configured");
  const job = downloadTracker.getJob(String(jobId || "").trim());
  if (!job || options.canAccessJob?.(job) === false) throw importError(404, "Download not found");
  if (job.status !== "done" || !job.finalPath) throw importError(409, "The track hasn't finished downloading");
  if (job.externalPath) throw importError(409, "The track is already in Lidarr");

  const key = path.resolve(job.finalPath);
  const inflight = inflightImports.get(key);
  if (inflight) return inflight;
  const request = runImport(job, options);
  inflightImports.set(key, request);
  // An import Lidarr is still running keeps its key until the background follow-up ends.
  request.catch((error) => error.background).finally(() => inflightImports.delete(key));
  return request;
}

/**
 * Imports a finished Aurral library download into Lidarr while "Import to Lidarr instead of the
 * Aurral library" is on, whatever queued it (Add to library, album grabs, missing-track search).
 * Never throws: on failure the file stays where Aurral committed it.
 */
export async function importDownloadedTrack(jobId, options = {}) {
  const id = String(jobId || "").trim();
  if (dbOps.getSettings().integrations?.lidarr?.importOnAddToLibrary !== true) return null;
  if (!lidarrClient.isConfigured()) return null;
  const job = downloadTracker.getJob(id);
  if (job?.playlistType !== "library" || job.status !== "done" || job.externalPath) return null;
  try {
    return await importTrackToLidarr({ jobId: id }, options);
  } catch (error) {
    if (error.stillImporting) return null;
    logger.warn("library", "Could not import downloaded track into Lidarr", {
      jobId: id,
      message: error.message,
      ...(error.rejections?.length ? { rejections: error.rejections } : {}),
    });
    return null;
  }
}
