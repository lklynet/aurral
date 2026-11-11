import { signedInAs } from "../helpers/honoApp.ts";
import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { db } from "../../backend/config/db-sqlite.ts";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.ts";
import {
  getLibraryAlbumPage,
  getLibraryArtistPage,
  getLibraryArtistKeyProjection,
  getLibraryArtistProjection,
  getLibraryPage,
  getLibraryTrackPage,
} from "../../backend/services/libraryQueryService.ts";
import { api } from "../../backend/routes/api.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const app = signedInAs(undefined).route("/", api);

test("artist key reads use identity columns and preserve metadata foreign IDs", () => {
  const identityKey = `artist-key-read:${Date.now()}`;
  const foreignArtistId = "artist-key-foreign-id";
  const artist = upsertLibraryArtist({
    identityKey,
    name: "Artist Key Read",
    metadata: { foreignArtistId },
  });
  const prepared: string[] = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    prepared.push(String(sql));
    return prepare(sql);
  });

  try {
    const projection = getLibraryArtistKeyProjection().find(
      (candidate) => candidate.id === String(artist.id),
    );
    assert.deepEqual(projection, {
      id: String(artist.id),
      mbid: null,
      foreignArtistId,
      name: "Artist Key Read",
      artistName: "Artist Key Read",
    });
    const sql = prepared.find((entry) => entry.includes("FROM library_artists"));
    assert.ok(sql);
    assert.match(sql, /SELECT id, identity_key, mbid, name, metadata_json/);
    assert.doesNotMatch(sql, /JOIN|COUNT|library_albums/);
  } finally {
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("library artist compatibility reads apply SQL pagination", async () => {
  const key = `canonical-artist-route:${process.pid}:${Date.now()}`;
  const artists: import("../../backend/db/rows.ts").LibraryArtistsRow[] = [];
  const albums: import("../../backend/db/rows.ts").LibraryAlbumsRow[] = [];
  const tracks: import("../../backend/db/rows.ts").LibraryTracksRow[] = [];
  const paths: string[] = [];
  for (const name of ["A", "B"]) {
    const artist = upsertLibraryArtist({
      identityKey: `${key}:artist:${name}`,
      name: `${key} ${name}`,
      sortName: `${key} ${name}`,
      metadata: { librarySource: "aurral" },
    });
    const album = upsertLibraryAlbum({
      identityKey: `${key}:album:${name}`,
      artistId: artist.id,
      title: `${key} Album ${name}`,
    });
    const track = upsertLibraryTrack({
      identityKey: `${key}:track:${name}`,
      title: `${key} Track ${name}`,
    });
    const filePath = `/tmp/${key}/${name}.flac`;
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "readonly",
      path: filePath,
      available: true,
    });
    artists.push(artist);
    albums.push(album);
    tracks.push(track);
    paths.push(filePath);
  }

  try {
    const response = await app.request(
      `/library/artists?${new URLSearchParams({ readPath: "library", source: "readonly", limit: "1", offset: "1" })}`,
    );
    const body: (ReturnType<
      typeof import("../../backend/services/libraryReadModel.ts").getLibraryReadModelForArtistPage
    >["artists"][number] & { added: string | null })[] = await response.json();
    assert.deepEqual(requireValue(body.map((artist) => artist.name)), [`${key} B`]);
    assert.equal(String(requireValue(body[0]).id), String(requireFixture(artists[1]).id));
    assert.equal(requireValue(body[0]).statistics.trackCount, 1);
    assert.equal(requireValue(body[0]).added, requireValue(body[0]).addedAt);
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path IN (?, ?)").run(...paths);
    db.prepare(
      "DELETE FROM library_album_tracks WHERE album_id IN (?, ?) OR track_id IN (?, ?)",
    ).run(...albums.map((album) => album.id), ...tracks.map((track) => track.id));
    db.prepare("DELETE FROM library_albums WHERE id IN (?, ?)").run(
      ...albums.map((album) => album.id),
    );
    db.prepare("DELETE FROM library_artists WHERE id IN (?, ?)").run(
      ...artists.map((artist) => artist.id),
    );
    db.prepare("DELETE FROM library_tracks WHERE id IN (?, ?)").run(
      ...tracks.map((track) => track.id),
    );
  }
});

test("library paginated reads keep tied rows stable", () => {
  const key = `canonical-stable-order:${process.pid}:${Date.now()}`;
  const artistName = `${key} Artist`;
  const albumTitle = `${key} Album`;
  const trackTitle = `${key} Track`;
  const artists: import("../../backend/db/rows.ts").LibraryArtistsRow[] = [];
  const albums: import("../../backend/db/rows.ts").LibraryAlbumsRow[] = [];
  const tracks: import("../../backend/db/rows.ts").LibraryTracksRow[] = [];
  const paths: string[] = [];
  let nullSortArtist: import("../../backend/db/rows.ts").LibraryArtistsRow | undefined;

  try {
    nullSortArtist = upsertLibraryArtist({
      identityKey: `${key}:null-sort-artist`,
      name: `${key} Null Sort Artist`,
      syncSearch: false,
    });
    for (const index of [0, 1]) {
      const artist = upsertLibraryArtist({
        identityKey: `${key}:artist:${index}`,
        name: artistName,
        sortName: artistName,
      });
      const album = upsertLibraryAlbum({
        identityKey: `${key}:album:${index}`,
        artistId: artist.id,
        title: albumTitle,
      });
      const track = upsertLibraryTrack({
        identityKey: `${key}:track:${index}`,
        title: trackTitle,
        artistName,
      });
      const filePath = `/tmp/${key}/${index}.flac`;
      linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
      upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "readonly",
        path: filePath,
        available: true,
      });
      artists.push(artist);
      albums.push(album);
      tracks.push(track);
      paths.push(filePath);
    }

    const expectedProjectionIds = artists.map((artist) => String(artist.id));
    const expectedIds = artists.map((artist) => artist.id);
    const projectionOffset = requireValue(
      db
        .prepare<unknown[], { count: number }>(
          `SELECT COUNT(*) AS count
       FROM library_artists
       WHERE sort_name IS NULL
          OR sort_name COLLATE NOCASE < ?
          OR (sort_name COLLATE NOCASE = ? AND (
            name COLLATE NOCASE < ?
            OR (name COLLATE NOCASE = ? AND id < ?)
          ))`,
        )
        .get(artistName, artistName, artistName, artistName, requireFixture(artists[0]).id),
    ).count;
    assert.deepEqual(
      getLibraryArtistProjection({ pageSize: 2, offset: projectionOffset }).map(
        (artist) => artist.id,
      ),
      expectedProjectionIds,
    );
    assert.deepEqual(
      [0, 1].map(
        (offset) =>
          getLibraryArtistProjection({
            pageSize: 1,
            offset: projectionOffset + offset,
          })[0]?.id,
      ),
      expectedProjectionIds,
    );

    assert.deepEqual(
      [0, 1].map(
        (offset) =>
          getLibraryArtistPage({
            source: "readonly",
            availableOnly: true,
            query: artistName,
            limit: 1,
            offset,
          }).artists[0]?.id,
      ),
      expectedIds,
    );
    assert.deepEqual(
      [0, 1].map(
        (offset) =>
          getLibraryAlbumPage({
            source: "readonly",
            availableOnly: true,
            query: albumTitle,
            limit: 1,
            offset,
          }).albums[0]?.id,
      ),
      albums.map((album) => album.id),
    );
    for (const sort of ["name", "artist", "newest"] as const) {
      const expectedTrackIds = getLibraryPage({
        source: "readonly",
        availableOnly: true,
        kind: "tracks",
        query: trackTitle,
        sort,
        pageSize: 2,
      }).tracks.map((track) => track.id);
      assert.deepEqual(
        [0, 1].map(
          (offset) =>
            getLibraryPage({
              source: "readonly",
              availableOnly: true,
              kind: "tracks",
              query: trackTitle,
              sort,
              pageSize: 1,
              offset,
            }).tracks[0]?.id,
        ),
        expectedTrackIds,
      );
    }
  } finally {
    if (paths.length) {
      db.prepare(
        `DELETE FROM library_media_files WHERE path IN (${paths.map(() => "?").join(",")})`,
      ).run(...paths);
    }
    for (const [kind, ids] of [
      ["artist", artists.map((artist) => artist.id)],
      ["album", albums.map((album) => album.id)],
      ["track", tracks.map((track) => track.id)],
    ] as const) {
      if (!ids.length) continue;
      db.prepare(
        `DELETE FROM library_search_documents
         WHERE entity_kind = ? AND entity_id IN (${ids.map(() => "?").join(",")})`,
      ).run(kind, ...ids);
    }
    if (albums.length) {
      db.prepare(
        `DELETE FROM library_album_tracks
         WHERE album_id IN (${albums.map(() => "?").join(",")})
            OR track_id IN (${tracks.map(() => "?").join(",")})`,
      ).run(...albums.map((album) => album.id), ...tracks.map((track) => track.id));
      db.prepare(`DELETE FROM library_albums WHERE id IN (${albums.map(() => "?").join(",")})`).run(
        ...albums.map((album) => album.id),
      );
    }
    if (artists.length) {
      db.prepare(
        `DELETE FROM library_artists WHERE id IN (${artists.map(() => "?").join(",")})`,
      ).run(...artists.map((artist) => artist.id));
    }
    if (tracks.length) {
      db.prepare(`DELETE FROM library_tracks WHERE id IN (${tracks.map(() => "?").join(",")})`).run(
        ...tracks.map((track) => track.id),
      );
    }
    if (nullSortArtist) {
      db.prepare("DELETE FROM library_artists WHERE id = ?").run(nullSortArtist.id);
    }
  }
});

test("legacy artist list bounds the projection before materialization", async () => {
  const prefix = `zzzzzzzzzz-artist-page-${process.pid}-${Date.now()}`;
  const artists = Array.from({ length: 101 }, (_, index) =>
    upsertLibraryArtist({
      identityKey: `${prefix}:${index}`,
      name: `${prefix}-${String(index).padStart(3, "0")}`,
      sortName: `${prefix}-${String(index).padStart(3, "0")}`,
    }),
  );

  try {
    const response = await app.request("/library/artists?limit=1&offset=100");
    const body: (ReturnType<typeof getLibraryArtistProjection>[number] & {
      added: string | null;
    })[] = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(requireValue(body.map((artist) => artist.id)), [
      String(requireFixture(artists[100]).id),
    ]);
    assert.equal(requireValue(body[0]).added, requireValue(body[0]).addedAt);
  } finally {
    db.prepare(`DELETE FROM library_artists WHERE id IN (${artists.map(() => "?").join(",")})`).run(
      ...artists.map((artist) => artist.id),
    );
  }
});

test("library artist page totals match hydrated items", () => {
  const key = `artist-page-shape:${process.pid}:${Date.now()}`;
  const emptyArtist = upsertLibraryArtist({
    identityKey: `${key}:empty`,
    name: `${key} empty`,
  });
  const populatedArtist = upsertLibraryArtist({
    identityKey: `${key}:populated`,
    name: `${key} populated`,
  });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: populatedArtist.id,
    title: "Hydrated Album",
  });
  const track = upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Hydrated Track",
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });

  try {
    const page = getLibraryPage({ kind: "artists", query: key });
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.items.map((artist) => artist.id),
      [populatedArtist.id],
    );
  } finally {
    db.prepare("DELETE FROM library_album_tracks WHERE album_id = ? OR track_id = ?").run(
      album.id,
      track.id,
    );
    db.prepare("DELETE FROM library_albums WHERE id = ?").run(album.id);
    db.prepare("DELETE FROM library_artists WHERE id IN (?, ?)").run(
      emptyArtist.id,
      populatedArtist.id,
    );
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(track.id);
  }
});

function requireValue<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

test("an artist with unreadable metadata fields keeps the rest of its details", () => {
  const artist = upsertLibraryArtist({
    identityKey: `unreadable-metadata:${Date.now()}`,
    name: "Unreadable Metadata Artist",
  });
  try {
    db.prepare("UPDATE library_artists SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({
        foreignArtistId: 42,
        monitorNewItems: "all",
        qualityProfile: { name: 5 },
        addOptions: "all",
      }),
      artist.id,
    );
    const [projection] = getLibraryArtistProjection({ reference: artist.id });
    assert.equal(projection?.foreignArtistId, artist.identity_key);
    assert.equal(projection?.monitorNewItems, "all");
    assert.equal(projection?.quality, "standard");
    assert.deepEqual(projection?.addOptions, { monitor: "none" });
  } finally {
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
  }
});

test("random songs leave out [silence] tracks", () => {
  const key = `random-silence:${process.pid}`;
  const artist = upsertLibraryArtist({ identityKey: `${key}:artist`, name: `${key} Artist` });
  const album = upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: artist.id,
    title: `${key} Album`,
  });
  for (const title of ["Song", "[silence]"]) {
    const track = upsertLibraryTrack({ identityKey: `${key}:${title}`, title });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
    upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "aurral",
      path: `/tmp/${key}/${title}.flac`,
    });
  }

  const titles = getLibraryTrackPage({ availableOnly: true, random: true, limit: 500 }).tracks.map(
    (track) => track.title,
  );

  assert.ok(titles.includes("Song"));
  assert.ok(!titles.includes("[silence]"));
});
