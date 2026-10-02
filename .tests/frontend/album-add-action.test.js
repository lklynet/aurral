import test from "node:test";
import assert from "node:assert/strict";

import {
  countReleaseTracks,
  describeAlbumRequestResult,
  getAlbumAddAction,
  isAlbumCompleteInLibrary,
  shouldTriggerAlbumSearch,
} from "../../frontend/src/utils/albumAddAction.js";

test("shouldTriggerAlbumSearch follows monitored state", () => {
  assert.equal(shouldTriggerAlbumSearch({ status: "available" }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "unmonitored", inLibrary: true }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "monitored" }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ inLibrary: true, monitored: false }), false);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: true }), true);
  assert.equal(shouldTriggerAlbumSearch({ status: "inLibrary", monitored: false }), false);
});

test("getAlbumAddAction labels adds with the destination manager", () => {
  const destination = { primary: "lidarr", alternative: "aurral", ready: true };
  assert.deepEqual(getAlbumAddAction({ status: "unmonitored" }, destination), {
    label: "Add to Lidarr",
    destination,
  });
  assert.equal(
    getAlbumAddAction({ inLibrary: true, monitored: false }, { primary: "aurral", alternative: null }).label,
    "Add to Aurral",
  );
});

test("getAlbumAddAction searches a monitored album through its own manager without a menu", () => {
  const action = getAlbumAddAction(
    { status: "monitored", managedBy: "aurral" },
    { primary: "lidarr", alternative: "aurral", ready: true },
  );
  assert.equal(action.label, "Search Album");
  assert.deepEqual(action.destination, { primary: "aurral", alternative: null, ready: true });
});

test("an unmonitored album stays with its owner when the default is another manager", () => {
  const action = getAlbumAddAction(
    { status: "unmonitored", inLibrary: true, managedBy: "aurral" },
    { primary: "lidarr", alternative: "aurral", ready: true },
  );
  assert.equal(action.destination.primary, "aurral");
  assert.equal(action.destination.alternative, null);
  assert.equal(action.label, "Add to Aurral");
});

test("isAlbumCompleteInLibrary only treats on-disk albums as complete", () => {
  assert.equal(isAlbumCompleteInLibrary({ status: "monitored" }), false);
  assert.equal(isAlbumCompleteInLibrary({ status: "available" }), true);
  assert.equal(isAlbumCompleteInLibrary({ sizeOnDisk: 1 }), true);
});

test("describeAlbumRequestResult does not claim a blocked album is downloading", () => {
  const queued = describeAlbumRequestResult({ status: "queued", jobIds: ["a"] }, "Dummy", "aurral");
  assert.equal(queued.kind, "success");
  assert.match(queued.message, /Aurral/);
  assert.match(queued.message, /queued/i);
  assert.doesNotMatch(queued.message, /downloading/i);
  const blocked = describeAlbumRequestResult({ status: "blocked", albumStatus: { recovery: { code: "download_source_missing" } } }, "Dummy", "lidarr");
  assert.equal(blocked.kind, "info");
  assert.match(blocked.message, /Lidarr/);
  assert.match(blocked.message, /nothing is downloading/);
  assert.equal(describeAlbumRequestResult({ albumStatus: { status: "blocked" } }, "Dummy").kind, "info");
  const available = describeAlbumRequestResult({ status: "available" }, "Dummy", "aurral");
  assert.match(available.message, /Aurral/);
  assert.doesNotMatch(available.message, /queued|downloading/i);
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
