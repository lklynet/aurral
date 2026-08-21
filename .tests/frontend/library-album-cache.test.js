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

  const { mergeAlbumTrackPageIntoLibrary } = await vite.ssrLoadModule(
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
