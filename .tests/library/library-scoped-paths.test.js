import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, store] = await setupIsolatedBackend(
  "library-scoped-paths", "backend/services/libraryMediaStore.js",
);
test.after(() => cleanupIsolatedState(state));

test("scoped media paths preserve exact files, descendants, and source boundaries", () => {
  const track = store.upsertLibraryTrack({ identityKey: "scoped:track", title: "Scoped Track" });
  for (const [source, filePath, available] of [
    ["aurral", "/library/Album/one.flac", true],
    ["aurral", "/library/Album/nested/two.flac", true],
    ["aurral", "/library/Album/something.flac", false],
    ["aurral", "/library/Album extra/three.flac", true],
    ["aurral", "/library/four%.flac", true],
    ["lidarr", "/library/Album/five.flac", true],
  ]) {
    store.upsertLibraryMediaFile({ trackId: track.id, source, path: filePath, available });
  }
  const read = (scopes) => [...store.getAvailableLibraryMediaPaths("aurral", scopes)].sort();
  assert.deepEqual(read(["/library/Album"]), [
    "/library/Album/nested/two.flac", "/library/Album/one.flac",
  ]);
  assert.deepEqual(read(["/library/Album/one.flac"]), ["/library/Album/one.flac"]);
  assert.deepEqual(read(["/library/four%.flac"]), ["/library/four%.flac"]);
  assert.deepEqual(read(["/library/Album", "/library/Album/nested", "/library/Album/"]), [
    "/library/Album/nested/two.flac", "/library/Album/one.flac",
  ]);
  assert.deepEqual(read([]), []);
});
