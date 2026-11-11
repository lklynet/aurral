import { db } from "../../config/db-sqlite.ts";
import { UnsupportedTagFormatError, writeAudioTags } from "../audioTags.ts";
import { getLibraryMediaFile } from "../libraryMediaStore.ts";
import { getAlbumByMbid, isMetadataNotFoundError } from "../providers/brainzmashProvider.ts";
import { readLibraryMetadata } from "../libraryMetadata.ts";
import { albumEdition } from "../releaseResolver.ts";
import { adoptLibraryFileIdentity } from "./fileIdentity.ts";
import { musicBrainzTags } from "./tagFill.ts";

type TrackFile = {
  path: string;
  source: string;
  album_id: number;
  album_title: string;
  album_metadata: string | null;
  release_group_mbid: string | null;
};

const TRACK_TAGS = [
  "title",
  "artist",
  "artistMbid",
  "trackNumber",
  "discNumber",
  "recordingMbid",
  "releaseGroupMbid",
  "releaseMbid",
] as const;

const refuse = <Status extends 404 | 409 | 503>(status: Status, error: string) => ({
  status,
  error,
});

async function loadTrackAlbum(trackId: number) {
  const files = db
    .prepare<[number], TrackFile>(
      `SELECT file.path, file.source, file.album_id, album.title AS album_title,
         album.metadata_json AS album_metadata, album.release_group_mbid
       FROM library_media_files AS file
       JOIN library_albums AS album ON album.id = file.album_id
       WHERE file.track_id = ? AND file.available = 1
       ORDER BY file.id`,
    )
    .all(trackId);
  if (!files.length) return refuse(404, "Track not found");
  const [first] = files.filter((file) => file.source === "aurral");
  if (!first) {
    return refuse(409, "This track's file is in a read-only folder, so Aurral cannot retag it.");
  }
  if (!first.release_group_mbid) return refuse(409, "Match the album first.");
  try {
    const group = await getAlbumByMbid(first.release_group_mbid);
    return {
      group,
      chosen: albumEdition(group, readLibraryMetadata(first.album_metadata) ?? {}),
      albumId: first.album_id,
      albumTitle: first.album_title,
      paths: files
        .filter((file) => file.source === "aurral" && file.album_id === first.album_id)
        .map((file) => file.path),
    };
  } catch (error) {
    if (isMetadataNotFoundError(error)) {
      return refuse(404, "MusicBrainz no longer has this album. Match the album again.");
    }
    return refuse(503, "Could not reach the metadata provider. Try again.");
  }
}

// A recording another track on the album already plays from a file would
// merge the two tracks, and there would be no telling the files apart again.
function heldRecordings(albumId: number, trackId: number) {
  return new Set(
    db
      .prepare<[number, number], string>(
        `SELECT DISTINCT track.mbid FROM library_media_files AS file
         JOIN library_tracks AS track ON track.id = file.track_id
         WHERE file.album_id = ? AND file.track_id != ? AND file.available = 1
           AND track.mbid IS NOT NULL`,
      )
      .pluck()
      .all(albumId, trackId),
  );
}

export async function listTrackMatches(trackId: number) {
  const loaded = await loadTrackAlbum(trackId);
  if ("error" in loaded) return loaded;
  const release = loaded.chosen ?? loaded.group.releases[0];
  const held = heldRecordings(loaded.albumId, trackId);
  const seen = new Set<string>();
  const items = (release?.tracks ?? [])
    .filter(({ recordingId }) => recordingId && !seen.has(recordingId) && seen.add(recordingId))
    .map((track) => ({
      id: track.recordingId,
      title: track.title,
      discNumber: track.mediumNumber || 1,
      trackNumber: track.trackNumber,
      durationMs: track.durationMs,
      inLibrary: held.has(track.recordingId),
    }));
  return { album: loaded.albumTitle, items };
}

// Overwrites the tags that say which track a file is, and leaves the
// album-wide ones alone, so a track fixed by hand keeps the album it is on.
export async function matchLibraryTrack(trackId: number, mbid: string) {
  const loaded = await loadTrackAlbum(trackId);
  if ("error" in loaded) return loaded;
  const { group, chosen, paths } = loaded;
  const match = [chosen, ...group.releases.filter((release) => release !== chosen)]
    .filter((release) => release != null)
    .flatMap((release) =>
      release.tracks
        .filter(
          (track) =>
            track.recordingId === mbid || track.id === mbid || track.oldRecordingIds.includes(mbid),
        )
        .map((track) => ({ release, track })),
    )[0];
  if (!match) return refuse(404, `That recording is not on ${group.title || "this album"}.`);
  if (heldRecordings(loaded.albumId, trackId).has(match.track.recordingId)) {
    return refuse(409, `${match.track.title} already has a file on this album.`);
  }
  const found = musicBrainzTags(group, match);
  const tags = Object.fromEntries(TRACK_TAGS.map((field) => [field, found[field]]));
  for (const path of paths) {
    try {
      await writeAudioTags(path, tags);
    } catch (error) {
      if (error instanceof UnsupportedTagFormatError) return refuse(409, error.message);
      throw error;
    }
    await adoptLibraryFileIdentity(path);
  }
  const [path] = paths;
  return {
    id: (path && getLibraryMediaFile({ source: "aurral", path })?.track_id) || trackId,
    title: match.track.title,
  };
}
