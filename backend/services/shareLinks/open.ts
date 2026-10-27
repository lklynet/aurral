import { db } from "../../config/db-sqlite.ts";
import type { LibraryAlbumsRow, LibraryArtistsRow } from "../../db/rows.ts";
import { findSharedTrack, type ShareManifest } from "../../../lib/shareManifest.ts";
import { getLibraryForTrackMatches } from "../libraryQueryService.ts";

export function shareDestination(manifest: ShareManifest) {
  const artist = db
    .prepare<[string | null, string, string | null, string | null], Pick<LibraryArtistsRow, "id">>(
      `SELECT id FROM library_artists WHERE mbid = ?
       OR (name = ? COLLATE NOCASE AND (? IS NULL OR mbid IS NULL))
       ORDER BY CASE WHEN mbid = ? THEN 0 ELSE 1 END, id LIMIT 1`,
    )
    .get(manifest.artistMbid, manifest.artistName, manifest.artistMbid, manifest.artistMbid);
  if (manifest.kind === "artist") {
    if (artist) return `/library/artist/${artist.id}`;
    if (manifest.artistMbid) return `/artist/${manifest.artistMbid}`;
  }
  if (manifest.kind === "album") {
    const album = db
      .prepare<
        [string | null, string, number | null, string | null, string | null],
        Pick<LibraryAlbumsRow, "id">
      >(
        `SELECT id FROM library_albums WHERE release_group_mbid = ?
         OR (title = ? COLLATE NOCASE AND artist_id = ? AND (? IS NULL OR release_group_mbid IS NULL))
         ORDER BY CASE WHEN release_group_mbid = ? THEN 0 ELSE 1 END, id LIMIT 1`,
      )
      .get(
        manifest.albumMbid,
        manifest.title,
        artist?.id || null,
        manifest.albumMbid,
        manifest.albumMbid,
      );
    if (album) return `/library/album/${album.id}`;
    if (manifest.artistMbid && manifest.albumMbid)
      return `/artist/${manifest.artistMbid}/release/${manifest.albumMbid}`;
  }
  if (manifest.kind === "track") {
    const requested = manifest.tracks[0] || {
      title: manifest.title,
      artistName: manifest.artistName,
      albumTitle: manifest.albumTitle,
      trackMbid: manifest.trackMbid,
      albumMbid: manifest.albumMbid,
      releaseMbid: null,
    };
    const library = getLibraryForTrackMatches({
      mbids: [requested.trackMbid],
      titles: [requested.title],
    });
    const candidates = library.tracks.flatMap((track) =>
      track.albums.flatMap((entry) => {
        const album = library.albums.find((album) => album.id === entry.albumId);
        return album
          ? [
              {
                id: track.id,
                albumId: album.id,
                title: track.title,
                artistName:
                  track.artistName ||
                  library.artists.find((artist) => artist.id === album.artistId)?.name ||
                  "",
                trackMbid: track.mbid,
                albumMbid: album.releaseGroupMbid,
                releaseMbid: album.mbid !== album.releaseGroupMbid ? album.mbid : null,
                albumTitle: album.title,
              },
            ]
          : [];
      }),
    );
    const track = findSharedTrack(candidates, requested);
    if (track) return `/library/album/${track.albumId}?track=${track.id}`;
  }
  return `/search?q=${encodeURIComponent(
    [manifest.title, manifest.artistName]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(" "),
  )}`;
}
