import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("library favorites include playlist-backed Subsonic songs", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { favoriteId, favoriteLibraryFromResponse } = await vite.ssrLoadModule(
    "/src/pages/LibraryPage.jsx?playlist-favorites-test",
  );
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
