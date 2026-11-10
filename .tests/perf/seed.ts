import type Database from "better-sqlite3";

const GENRES = [
  "Rock",
  "Pop",
  "Electronic",
  "Hip-Hop",
  "Jazz",
  "Folk",
  "Metal",
  "Ambient",
  "Soul",
  "Country",
  "Classical",
  "Punk",
];

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const uuid = (prefix: number, value: number) => `${prefix}0000000-0000-4000-8000-${pad(value, 12)}`;

export type PerfLibrary = ReturnType<typeof seedPerfLibrary>;

export function seedPerfLibrary(
  db: Database.Database,
  { artists, musicRoot }: { artists: number; musicRoot: string },
) {
  const now = Date.UTC(2026, 0, 1);
  const insertArtist = db.prepare(
    `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAlbum = db.prepare(
    `INSERT INTO library_albums
      (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrack = db.prepare(
    `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAlbumTrack = db.prepare(
    `INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertFile = db.prepare(
    `INSERT INTO library_media_files
      (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, created_at, updated_at, artist_tag)
     VALUES (?, ?, 'aurral', ?, 'flac', 31457280, ?, ?, '{"format":"FLAC","bitrate":1000}', 1, ?, ?, ?)`,
  );
  const insertImageLookup = db.prepare(
    `INSERT INTO images_cache (mbid, image_url, images_json, cache_age, created_at)
     VALUES (?, 'NOT_FOUND', '[]', ?, ?)`,
  );
  const insertManagement = db.prepare(
    `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
     VALUES (?, ?, 'aurral', ?, ?, ?)`,
  );

  const albumIds: number[] = [];
  const trackRows: {
    id: number;
    key: string;
    title: string;
    artist: string;
    album: string;
    albumKey: string;
    path: string | null;
  }[] = [];
  let trackIndex = 0;

  db.transaction(() => {
    for (let artistIndex = 0; artistIndex < artists; artistIndex += 1) {
      const artistName = `Perf Artist ${pad(artistIndex, 5)}`;
      const genre = GENRES[artistIndex % GENRES.length]!;
      const artistId = Number(
        insertArtist.run(
          `perf:artist:${artistIndex}`,
          uuid(1, artistIndex),
          artistName,
          artistName,
          JSON.stringify({ genres: [genre] }),
          now - artistIndex * 60_000,
          now,
        ).lastInsertRowid,
      );
      insertManagement.run("artist", artistId, "none", now, now);
      insertImageLookup.run(uuid(1, artistIndex), Date.now(), Date.now());
      const albumCount = 4 + (artistIndex % 7);
      for (let albumOffset = 0; albumOffset < albumCount; albumOffset += 1) {
        const albumIndex = albumIds.length;
        const albumTitle = `Perf Album ${pad(albumIndex, 6)}`;
        const multiDisc = albumIndex % 10 === 0;
        const albumId = Number(
          insertAlbum.run(
            `perf:album:${albumIndex}`,
            uuid(2, albumIndex),
            uuid(3, albumIndex),
            artistId,
            albumTitle,
            artistName,
            `${1970 + (albumIndex % 56)}-${pad((albumIndex % 12) + 1, 2)}-01`,
            JSON.stringify({
              genres: [genre, GENRES[(artistIndex + albumOffset + 1) % GENRES.length]],
              trackListComplete: true,
            }),
            now - albumIndex * 60_000,
            now,
          ).lastInsertRowid,
        );
        albumIds.push(albumId);
        insertManagement.run("album", albumId, "all", now, now);
        const trackCount = 8 + (albumIndex % 9);
        for (let position = 0; position < trackCount; position += 1) {
          const featured = trackIndex % 15 === 0;
          const trackArtist = featured
            ? `${artistName} feat. Perf Artist ${pad((artistIndex + 1) % artists, 5)}`
            : artistName;
          const title = `Perf Track ${pad(trackIndex, 7)}`;
          const trackId = Number(
            insertTrack.run(
              `perf:track:${trackIndex}`,
              uuid(4, trackIndex),
              title,
              trackArtist,
              JSON.stringify({ genres: [genre] }),
              now - trackIndex * 1_000,
              now,
            ).lastInsertRowid,
          );
          const disc = multiDisc && position >= trackCount / 2 ? 2 : 1;
          insertAlbumTrack.run(albumId, trackId, disc, position + 1, now);
          const path =
            trackIndex % 20 === 7
              ? null
              : `${musicRoot}/${artistName}/${albumTitle}/${disc}-${pad(position + 1, 2)} ${title}.flac`;
          if (path) {
            insertFile.run(
              trackId,
              albumId,
              path,
              now,
              150_000 + (trackIndex % 120) * 1_000,
              now - trackIndex * 1_000,
              now,
              trackArtist,
            );
          }
          trackRows.push({
            id: trackId,
            key: `perf:track:${trackIndex}`,
            title,
            artist: trackArtist,
            album: albumTitle,
            albumKey: `perf:album:${albumIndex}`,
            path,
          });
          trackIndex += 1;
        }
      }
    }
  })();

  return {
    artists,
    albums: albumIds.length,
    tracks: trackRows.length,
    albumIds,
    trackRows,
  };
}

export function seedPerfListening(
  db: Database.Database,
  userId: number,
  library: Pick<PerfLibrary, "trackRows" | "albums">,
) {
  const now = Date.UTC(2026, 0, 1);
  const insertPlay = db.prepare(
    `INSERT INTO play_events (user_id, track_id, title, artist, album, album_key, duration_ms, played_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 200000, ?, 'web', ?)`,
  );
  const upsertAlbumStats = db.prepare(
    `INSERT INTO play_album_stats (user_id, album_key, play_count, last_played_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (user_id, album_key) DO UPDATE SET play_count = play_count + 1, last_played_at = excluded.last_played_at`,
  );
  const insertStar = db.prepare(
    "INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (?, ?, ?, ?)",
  );
  const { trackRows } = library;
  const plays = Math.min(5_000, trackRows.length * 2);
  db.transaction(() => {
    for (let index = 0; index < plays; index += 1) {
      const track = trackRows[(index * 7919) % Math.min(trackRows.length, 2_000)]!;
      const playedAt = now - index * 180_000;
      insertPlay.run(
        userId,
        track.key,
        track.title,
        track.artist,
        track.album,
        track.albumKey,
        playedAt,
        playedAt,
      );
      upsertAlbumStats.run(userId, track.albumKey, playedAt);
    }
    for (let index = 0; index < Math.min(300, trackRows.length); index += 1) {
      insertStar.run(userId, "song", trackRows[(index * 3) % trackRows.length]!.key, now);
    }
    for (let index = 0; index < Math.min(60, library.albums); index += 1) {
      insertStar.run(userId, "album", `perf:album:${index * 2}`, now);
    }
    for (let index = 0; index < 25; index += 1) {
      insertStar.run(userId, "artist", `perf:artist:${index}`, now);
    }
  })();
}

const HISTORY_JOBS = 5_000;
const EDIT_SONGS = 25;
export const EDIT_SETS = 16;

export function seedPerfPlaylistJobs(
  db: Database.Database,
  library: Pick<PerfLibrary, "trackRows">,
) {
  const now = Date.UTC(2026, 0, 1);
  const insertJob = db.prepare(
    `INSERT INTO download_jobs
      (id, artist_name, track_name, album_name, owner_id, owner_type, status, final_path, completed_at, created_at, managed_by, reused_library_file)
     VALUES (?, ?, ?, ?, 'library', 'library', 'done', ?, ?, ?, 'aurral', 1)`,
  );
  const playlists = Array.from({ length: 8 }, (_, index) =>
    library.trackRows
      .slice(index * 600, (index + 1) * 600)
      .filter((track) => track.path)
      .slice(0, 50 + index * 60),
  );
  db.transaction(() => {
    for (const track of playlists.flat()) {
      insertJob.run(
        `perf-job-${track.id}`,
        track.artist,
        track.title,
        track.album,
        track.path,
        now,
        now,
      );
    }
    for (let index = 0; index < HISTORY_JOBS; index += 1) {
      insertJob.run(
        `perf-history-${index}`,
        `History Artist ${index % 997}`,
        `History Song ${index}`,
        `History Album ${index % 3001}`,
        `/history/${index}.flac`,
        now,
        now,
      );
    }
  })();
  const unlinked = library.trackRows.filter((track) => track.path).slice(-EDIT_SONGS * EDIT_SETS);
  return {
    playlists: playlists.map((tracks) =>
      tracks.map((track) => ({
        artistName: track.artist,
        trackName: track.title,
        albumName: track.album,
        canonicalJobId: `perf-job-${track.id}`,
        path: track.path!,
      })),
    ),
    editSongs: Array.from({ length: EDIT_SETS }, (_, set) =>
      unlinked
        .slice(set * EDIT_SONGS, (set + 1) * EDIT_SONGS)
        .map((track) => ({ id: `song:${track.key}`, path: track.path! })),
    ),
  };
}
