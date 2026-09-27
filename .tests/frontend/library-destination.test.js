import test from "node:test";
import assert from "node:assert/strict";

import {
  getAddToManagerLabel,
  resolveLibraryDestination,
} from "../../frontend/src/utils/libraryDestination.js";

test("resolveLibraryDestination keeps Lidarr first for connected users without a preference", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: null, lidarrConfigured: true }),
    { primary: "lidarr", alternative: "aurral" },
  );
});

test("resolveLibraryDestination puts a saved Aurral preference first", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "aurral", lidarrConfigured: true }),
    { primary: "aurral", alternative: "lidarr" },
  );
});

test("resolveLibraryDestination offers only Aurral when Lidarr is unavailable", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: null, lidarrConfigured: false }),
    { primary: "aurral", alternative: null },
  );
});

test("resolveLibraryDestination falls back when the saved manager is unavailable", () => {
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "lidarr", lidarrConfigured: false }),
    { primary: "aurral", alternative: null },
  );
  assert.deepEqual(
    resolveLibraryDestination({ libraryOwner: "plex", lidarrConfigured: true }),
    { primary: "lidarr", alternative: "aurral" },
  );
});

test("add labels name each manager", () => {
  assert.equal(getAddToManagerLabel("aurral"), "Add to Aurral");
  assert.equal(getAddToManagerLabel("lidarr"), "Add to Lidarr");
});
