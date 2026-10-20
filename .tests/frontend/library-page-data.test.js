import assert from "node:assert/strict";
import test from "node:test";
import { idFor } from "../../backend/services/subsonicLibraryService.js";
import { startFrontendServer } from "../helpers/frontendServer.js";

const vite = await startFrontendServer();
test.after(() => vite.close());

const {
  albumCardMeta,
  favoriteId,
  favoriteLibraryFromResponse,
  getAlbumCoverId,
  getCachedAlbumTracks,
  mergeAlbumTrackPageIntoLibrary,
} = await vite.ssrLoadModule("/src/utils/libraryPageData.js");
const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");

test("album track hydration does not rewrite unchanged library state", () => {
  const album = { id: 7, title: "Album", trackCount: 0, availableTrackCount: 0 };
  const track = { id: 8, files: [{ available: true }] };
  const current = { artists: [], albums: [album], tracks: [track] };
  const page = { artists: [], albums: [album], tracks: [track] };

  const hydrated = mergeAlbumTrackPageIntoLibrary(current, page, album.id, [track]);
  assert.notStrictEqual(hydrated, current);
  assert.equal(hydrated.albums[0].trackCount, 1);
  assert.equal(hydrated.albums[0].availableTrackCount, 1);
  assert.strictEqual(
    mergeAlbumTrackPageIntoLibrary(hydrated, page, album.id, [track]),
    hydrated,
  );
});

test("invalidated album track caches fall back to the current library tracks", (t) => {
  t.after(() => queryClient.clear());
  const album = { id: 7, trackIds: [8, 9] };
  const tracksById = new Map([
    ["8", { id: 8 }],
    ["9", { id: 9 }],
  ]);
  const queryKey = queryKeys.libraryAlbumTracks("7", null);
  queryClient.setQueryData(queryKey, { tracks: [{ id: 8 }, { id: 9 }] });

  queryClient.invalidateQueries({ queryKey, refetchType: "none" });
  tracksById.delete("9");

  assert.deepEqual(getCachedAlbumTracks(album, tracksById), [{ id: 8 }]);
});

test("library covers prefer the release-group MBID", () => {
  assert.equal(
    getAlbumCoverId({ mbid: "release-id", releaseGroupMbid: "release-group-id" }),
    "release-group-id",
  );
});

test("library favorites include playlist-backed Subsonic songs", () => {
  const playlistSong = {
    id: "shared-song:playlist-id%3Ajob-id",
    title: "Playlist Favorite",
    artist: "Favorite Artist",
    album: "Favorite Album",
    duration: 223,
    suffix: "flac",
  };
  const library = favoriteLibraryFromResponse({
    library: {
      artists: [],
      albums: [],
      tracks: [{ id: 1, identityKey: "canonical-song", title: "Canonical Favorite" }],
    },
    song: [
      { id: "song:canonical-song", title: "Canonical Favorite" },
      playlistSong,
    ],
  });

  assert.deepEqual(library.tracks.map((track) => track.title), [
    "Canonical Favorite",
    "Playlist Favorite",
  ]);
  assert.equal(favoriteId("song", library.tracks[1]), playlistSong.id);
  assert.match(library.tracks[1].files[0].previewUrl, /\/playlists\/stream\/job-id/);
});

test("favorite ids match the ids the favorites endpoint returns", () => {
  const entities = [
    ["artist", { identityKey: "mbid:artist:4a3c2f0e-0000-4000-8000-000000000000" }],
    ["album", { identityKey: "name:album:sol:the album" }],
    ["song", { identityKey: "name:track:name album:1:1:sol" }],
  ];

  for (const [kind, entity] of entities) {
    assert.equal(favoriteId(kind, entity), idFor(kind, entity.identityKey));
  }
});

test("album cards tell an artist's same-titled releases apart", () => {
  const blue = { title: "Weezer", releaseDate: "1994-05-10", metadata: { tags: { releasetype: ["album"] } } };
  const green = { title: "Weezer", releaseDate: "2001-05-15", metadata: { albumType: "Album" } };
  const single = { title: "Island in the Sun", releaseDate: "2001", metadata: { tags: { releasetype: ["single"] } } };
  const ep = { title: "Weezer", metadata: { albumType: "EP" } };

  assert.deepEqual(albumCardMeta(blue, { available: 10, total: 10 }), {
    details: "1994",
    count: "10 tracks",
    partial: false,
  });
  assert.deepEqual(albumCardMeta(green, { available: 9, total: 10 }), {
    details: "2001",
    count: "9/10 tracks",
    partial: true,
  });
  assert.deepEqual(albumCardMeta(single, { available: 1, total: 1 }), {
    details: "Single · 2001",
    count: "1 track",
    partial: false,
  });
  assert.deepEqual(albumCardMeta(ep, { available: 0, total: 0 }), {
    details: "EP",
    count: "0 tracks",
    partial: false,
  });
});
