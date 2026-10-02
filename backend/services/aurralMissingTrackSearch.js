import { db } from "../config/db-sqlite.js";
import { dbOps } from "../db/helpers/index.js";
import { ACTIVE_JOB_STATUSES, indexAurralAlbumJobs, jobMatchesTrack } from "./aurralAlbumJobs.js";
import { recordMissingTrackSearch } from "./aurralHistoryService.js";
import { AURRAL_ALBUM_CONDITION, monitoredTrackCondition } from "./aurralMonitoring.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { libraryManager } from "./libraryManager.js";
import { albumMediaCondition } from "./libraryQueryService.js";
import { logger } from "./logger.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MISSING_TRACK_CONDITION = `
  ${monitoredTrackCondition("track")}
  AND NOT EXISTS (
    SELECT 1 FROM library_media_files AS media
    WHERE media.track_id = link.track_id
      AND media.available = 1
      AND ${albumMediaCondition("media", "link")}
  )
`;

const candidateAlbumsStmt = db.prepare(`
  SELECT
    album.id,
    album.title,
    COALESCE(album.mbid, album.release_group_mbid) AS mbid,
    artist.name AS artistName,
    artist.mbid AS artistMbid,
    management.last_missing_search_at AS lastSearchedAt
  FROM library_management AS management
  JOIN library_albums AS album ON album.id = management.entity_id
  JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE ${AURRAL_ALBUM_CONDITION}
    AND COALESCE(album.mbid, album.release_group_mbid) IS NOT NULL
    AND (management.last_missing_search_at IS NULL OR management.last_missing_search_at <= ?)
    AND EXISTS (
      SELECT 1 FROM library_album_tracks AS link
      JOIN library_tracks AS track ON track.id = link.track_id
      WHERE link.album_id = album.id AND ${MISSING_TRACK_CONDITION}
    )
`);

const missingTracksStmt = db.prepare(`
  SELECT track.mbid, track.title
  FROM library_album_tracks AS link
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE link.album_id = ? AND ${MISSING_TRACK_CONDITION}
`);

const markSearchedStmt = db.prepare(`
  UPDATE library_management
  SET last_missing_search_at = ?
  WHERE entity_kind = 'album' AND entity_id = ?
`);

const jobActivityAt = (job) =>
  Math.max(Number(job.createdAt) || 0, Number(job.startedAt) || 0, Number(job.completedAt) || 0);

const isActiveOrCancelled = (job) => ACTIVE_JOB_STATUSES.has(job.status) || job.status === "cancelled";

function hasSearchableMissingTrack(album, jobs) {
  return missingTracksStmt.all(album.id).some((track) => {
    const latestJob = jobs.filter((job) => jobMatchesTrack(job, track)).at(-1);
    return latestJob?.status !== "blocked";
  });
}

function selectDueAlbums(intervalDays) {
  const dueBefore = Date.now() - intervalDays * DAY_MS + HOUR_MS;
  const jobsForAlbum = indexAurralAlbumJobs();
  const candidates = candidateAlbumsStmt.all(dueBefore)
    .map((album) => {
      const jobs = jobsForAlbum(album.mbid);
      const lastActivityAt = Math.max(Number(album.lastSearchedAt) || 0, ...jobs.map(jobActivityAt));
      return { album, jobs, lastActivityAt };
    })
    .filter(({ jobs, lastActivityAt }) => lastActivityAt <= dueBefore && !jobs.some(isActiveOrCancelled))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt || left.album.id - right.album.id);
  return candidates
    .filter(({ album, jobs }) => hasSearchableMissingTrack(album, jobs))
    .map(({ album }) => album);
}

async function searchAlbumMissingTracks(album) {
  try {
    const result = await libraryManager.searchAurralAlbumMissingTracks(album.id);
    if (result?.error) {
      logger.warn("library", "Missing-track search could not search an album", {
        albumId: album.id,
        message: result.error,
      });
    } else {
      recordMissingTrackSearch({
        albumId: album.id,
        albumName: album.title,
        artistName: album.artistName,
        artistMbid: album.artistMbid,
        queuedTrackCount: result?.queuedTrackCount,
      });
    }
  } catch (error) {
    logger.warn("library", "Missing-track search could not search an album", {
      albumId: album.id,
      message: error?.message || String(error),
    });
  }
  markSearchedStmt.run(Date.now(), album.id);
}

export async function runMissingTrackSearch() {
  const settings = dbOps.getSettings().missingTrackSearch;
  if (!settings.enabled || !isAnyDownloadSourceConfigured()) return 0;
  const dueAlbums = selectDueAlbums(settings.intervalDays);
  for (const album of dueAlbums) await searchAlbumMissingTracks(album);
  return dueAlbums.length;
}
