import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("album track hydration does not rewrite unchanged library state", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { getCachedAlbumTracks, mergeAlbumTrackPageIntoLibrary } = await vite.ssrLoadModule(
    "/src/pages/LibraryPage.jsx?album-cache-test",
  );
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

test("invalidated album track caches fall back to the current library tracks", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { getCachedAlbumTracks } = await vite.ssrLoadModule(
    "/src/pages/LibraryPage.jsx?album-cache-removal-test",
  );
  const { queryClient, queryKeys } = await vite.ssrLoadModule("/src/queryClient.js");
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
  queryClient.clear();
});
