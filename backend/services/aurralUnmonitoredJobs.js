import path from "path";
import { db } from "../config/db-sqlite.js";
import { isAurralAlbumJob, jobMatchesTrack } from "./aurralAlbumJobs.js";
import { MONITORED_AURRAL_ALBUM_CONDITION, monitoredTrackCondition } from "./aurralMonitoring.js";
import { albumMediaCondition } from "./libraryQueryService.js";

const UNMONITORED_AURRAL_ALBUM_CONDITION = `EXISTS (
  SELECT 1
  FROM library_management AS management
  WHERE management.entity_kind = 'album'
    AND management.entity_id = album.id
    AND management.managed_by = 'aurral'
    AND NOT (${MONITORED_AURRAL_ALBUM_CONDITION})
)`;

const unmonitoredFilePathsStmt = db.prepare(`
  SELECT media.path
  FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE media.source = 'aurral'
    AND (
      NOT (${monitoredTrackCondition("track")})
      OR EXISTS (
        SELECT 1
        FROM library_album_tracks AS album_track
        JOIN library_albums AS album ON album.id = album_track.album_id
        WHERE album_track.track_id = media.track_id
          AND ${albumMediaCondition("media", "album_track")}
          AND ${UNMONITORED_AURRAL_ALBUM_CONDITION}
      )
    )
`).pluck();

const unmonitoredAlbumsStmt = db.prepare(`
  SELECT album.mbid, album.release_group_mbid AS releaseGroupMbid
  FROM library_albums AS album
  WHERE ${UNMONITORED_AURRAL_ALBUM_CONDITION}
`);

const unmonitoredTracksStmt = db.prepare(`
  SELECT album.mbid AS albumMbid, album.release_group_mbid AS releaseGroupMbid,
    track.mbid, track.title
  FROM library_album_tracks AS link
  JOIN library_albums AS album ON album.id = link.album_id
  JOIN library_tracks AS track ON track.id = link.track_id
  JOIN library_management AS management
    ON management.entity_kind = 'album' AND management.entity_id = album.id
  WHERE management.managed_by = 'aurral'
    AND NOT (${monitoredTrackCondition("track")})
`);

const albumKey = (value) => String(value || "").trim().toLowerCase();

export function indexUnmonitoredJobs() {
  const filePaths = new Set(unmonitoredFilePathsStmt.all());
  const albums = new Set();
  for (const album of unmonitoredAlbumsStmt.all()) {
    for (const key of [album.mbid, album.releaseGroupMbid]) if (key) albums.add(albumKey(key));
  }
  const tracksByAlbum = new Map();
  for (const track of unmonitoredTracksStmt.all()) {
    for (const key of new Set([track.albumMbid, track.releaseGroupMbid].filter(Boolean).map(albumKey))) {
      tracksByAlbum.set(key, [...(tracksByAlbum.get(key) || []), track]);
    }
  }
  return (job) => {
    if (job?.finalPath && filePaths.has(path.resolve(job.finalPath))) return true;
    if (!job || !isAurralAlbumJob(job)) return false;
    const key = albumKey(job.albumMbid);
    if (!key) return false;
    return albums.has(key) || (tracksByAlbum.get(key) || []).some((track) => jobMatchesTrack(job, track));
  };
}
