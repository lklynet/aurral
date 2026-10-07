import test from "node:test";
import assert from "node:assert/strict";

import {
  countReleaseTracks,
  describeAlbumRequestResult,
  getAlbumAddAction,
  isAlbumCompleteInLibrary,
  shouldTriggerAlbumSearch,
} from "../../frontend/src/utils/albumAddAction.js";
import { resolveReleaseLibraryDisplay } from "../../frontend/src/pages/ArtistDetails/utils.js";

test("shouldTriggerAlbumSearch follows monitored state", () => {
  assert.equal(shouldTriggerAlbumSearch({ status: "available" }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "unmonitored", inLibrary: true }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "monitored" }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: false }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: false }), false);
});

test("every album action is a Download album button for the active manager", () => {
  const lidarr = { primary: "lidarr", ready: true };
  const action = getAlbumAddAction({ status: "monitored", managedBy: "aurral" }, lidarr);
  assert.equal(action.label, "Download album");
  assert.equal(action.destination, lidarr);
  assert.equal(getAlbumAddAction({ inLibrary: true, monitored: false }, { primary: "aurral" }).label, "Download album");
});

test("isAlbumCompleteInLibrary only treats on-disk albums as complete", () => {
  assert.equal(isAlbumCompleteInLibrary({ status: "monitored" }), false);
  assert.equal(isAlbumCompleteInLibrary({ status: "available" }), true);
  assert.equal(isAlbumCompleteInLibrary({ sizeOnDisk: 1 }), true);
});

test("album request results describe what happens without naming a manager", () => {
  const queued = describeAlbumRequestResult({ status: "queued", jobIds: ["a"] }, "Dummy");
  assert.deepEqual(queued, { kind: "success", message: "Downloading Dummy" });
  const blocked = describeAlbumRequestResult({ status: "blocked" }, "Dummy");
  assert.equal(blocked.kind, "info");
  assert.match(blocked.message, /nothing is downloading/);
  assert.equal(describeAlbumRequestResult({ albumStatus: { status: "blocked" } }, "Dummy").kind, "info");
  assert.equal(describeAlbumRequestResult({ triggeredSearch: true }, "Dummy").message, "Searching for Dummy");
  for (const message of [queued.message, blocked.message]) assert.doesNotMatch(message, /Aurral|Lidarr/);
});

test("an unmonitored Aurral album counts the release's tracks, so a downloaded single isn't complete", () => {
  const single = {
    inLibrary: true,
    managedBy: "aurral",
    monitored: false,
    trackCount: 1,
    trackFileCount: 1,
    percentOfTracks: 100,
  };
  const counted = countReleaseTracks(single, 4);

  assert.deepEqual([counted.trackCount, counted.percentOfTracks], [4, 25]);
  for (const library of [
    { ...single, monitored: true },
    { ...single, managedBy: "lidarr" },
    { ...single, trackCount: 4, trackFileCount: 4 },
  ]) {
    assert.equal(countReleaseTracks(library, 4), library);
  }
});

test("release display keeps albums with an incomplete track list incomplete", () => {
  const lookup = { inLibrary: true, managedBy: "aurral", monitored: true,
    trackListComplete: false, trackCount: 1, trackFileCount: 1 };
  const display = resolveReleaseLibraryDisplay(countReleaseTracks(lookup, 12));
  assert.equal(display.isComplete, false);
  assert.equal(display.kind, "incomplete");
  assert.equal(display.label, "Incomplete");
  const complete = resolveReleaseLibraryDisplay({ ...lookup, trackListComplete: true, percentOfTracks: 100 });
  assert.equal(complete.isComplete, true);
  assert.equal(complete.label, "In library");
});
