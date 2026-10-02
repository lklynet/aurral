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

test("album actions always go to the active manager, whoever holds the album now", () => {
  const lidarr = { primary: "lidarr", ready: true };
  assert.deepEqual(getAlbumAddAction({ status: "unmonitored", inLibrary: true, managedBy: "aurral" }, lidarr), {
    label: "Add to Lidarr",
    destination: lidarr,
  });
  assert.equal(getAlbumAddAction({ status: "monitored", managedBy: "aurral" }, lidarr).label, "Search Album");
  assert.equal(getAlbumAddAction({ inLibrary: true, monitored: false }, { primary: "aurral" }).label, "Add to library");
});

test("isAlbumCompleteInLibrary only treats on-disk albums as complete", () => {
  assert.equal(isAlbumCompleteInLibrary({ status: "monitored" }), false);
  assert.equal(isAlbumCompleteInLibrary({ status: "available" }), true);
  assert.equal(isAlbumCompleteInLibrary({ sizeOnDisk: 1 }), true);
});

test("describeAlbumRequestResult does not claim a blocked album is downloading", () => {
  const queued = describeAlbumRequestResult({ status: "queued", jobIds: ["a"] }, "Dummy", "aurral");
  assert.equal(queued.kind, "success");
  assert.match(queued.message, /your library/);
  assert.match(queued.message, /queued/i);
  assert.doesNotMatch(queued.message, /downloading/i);
  const blocked = describeAlbumRequestResult({ status: "blocked", albumStatus: { recovery: { code: "download_source_missing" } } }, "Dummy", "lidarr");
  assert.equal(blocked.kind, "info");
  assert.match(blocked.message, /Lidarr/);
  assert.match(blocked.message, /nothing is downloading/);
  assert.equal(describeAlbumRequestResult({ albumStatus: { status: "blocked" } }, "Dummy").kind, "info");
  const available = describeAlbumRequestResult({ status: "available" }, "Dummy", "aurral");
  assert.match(available.message, /your library/);
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
