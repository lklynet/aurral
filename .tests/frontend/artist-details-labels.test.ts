import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  getArtistType,
  getDownloadStatusLabel,
  resolveReleaseLibraryDisplay,
} from "../../frontend/src/pages/ArtistDetails/utils.ts";

test("artist types that are not known labels show as written", () => {
  assert.equal(getArtistType("Person"), "Solo artist");
  assert.equal(getArtistType("constructor"), "constructor");
  assert.equal(getArtistType(null), null);
});

test("a download status that is not a known label shows as written", () => {
  const libraryInfo = { inLibrary: true, trackCount: 10, trackFileCount: 0 };
  assert.equal(getDownloadStatusLabel("constructor"), "constructor");
  assert.equal(
    resolveReleaseLibraryDisplay(libraryInfo, { status: "moving" }).label,
    "Moving files...",
  );
  assert.equal(
    resolveReleaseLibraryDisplay(libraryInfo, { status: "constructor" }).label,
    "constructor",
  );
});
