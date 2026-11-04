import { db } from "../../config/db-sqlite.ts";
import type { LibraryArtistsRow, LibraryTracksRow } from "../../db/rows.ts";
import { isVariousArtistsCredit, withoutFeaturedArtists } from "../trackMatching/titleText.ts";

const favoriteCreditsStmt = db.prepare<
  [{ userId: number }],
  {
    name: LibraryArtistsRow["name"] | null;
    mbid: LibraryArtistsRow["mbid"];
    artist_name: LibraryTracksRow["artist_name"];
  }
>(`
  SELECT artist.name, artist.mbid, NULL AS artist_name
  FROM subsonic_stars AS star
  JOIN library_artists AS artist ON artist.identity_key = star.entity_key
  WHERE star.user_id = @userId AND star.entity_kind = 'artist'
  UNION ALL
  SELECT artist.name, artist.mbid, NULL
  FROM subsonic_stars AS star
  JOIN library_albums AS album ON album.identity_key = star.entity_key
  JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE star.user_id = @userId AND star.entity_kind = 'album'
  UNION ALL
  SELECT artist.name, artist.mbid, track.artist_name
  FROM subsonic_stars AS star
  JOIN library_tracks AS track ON track.identity_key = star.entity_key
  LEFT JOIN library_artists AS artist ON artist.id = (
    SELECT album.artist_id
    FROM library_album_tracks AS link
    JOIN library_albums AS album ON album.id = link.album_id
    WHERE link.track_id = track.id
    ORDER BY album.id
    LIMIT 1
  )
  WHERE star.user_id = @userId AND star.entity_kind = 'song'
`);

// A starred song on a compilation counts for its performer, not "Various Artists".
export const getTopFavoriteArtists = (userId: number, limit: number) => {
  const credits = favoriteCreditsStmt.all({ userId }).flatMap((row) => {
    const performer = withoutFeaturedArtists(row.artist_name);
    const { artistName, mbid } =
      performer && (!row.name || isVariousArtistsCredit(row.name, row.mbid))
        ? { artistName: performer, mbid: null }
        : { artistName: row.name, mbid: row.mbid };
    return artistName && !isVariousArtistsCredit(artistName, mbid) ? [{ artistName, mbid }] : [];
  });
  const mbidByName = new Map(
    credits.flatMap(({ artistName, mbid }) => (mbid ? [[artistName.toLowerCase(), mbid]] : [])),
  );
  const counts = new Map<string, { artistName: string; mbid: string | null; playcount: number }>();
  for (const credit of credits) {
    const name = credit.artistName.toLowerCase();
    const mbid = credit.mbid || mbidByName.get(name) || null;
    const key = mbid || name;
    const entry = counts.get(key) ?? { artistName: credit.artistName, mbid, playcount: 0 };
    entry.playcount += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort(
      (left, right) =>
        right.playcount - left.playcount || left.artistName.localeCompare(right.artistName),
    )
    .slice(0, limit);
};
