import test from "node:test";
import assert from "node:assert/strict";

import {
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

test("isAlbumCompleteInLibrary only treats on-disk albums as complete", () => {
  assert.equal(isAlbumCompleteInLibrary({ status: "monitored" }), false);
  assert.equal(isAlbumCompleteInLibrary({ status: "available" }), true);
  assert.equal(isAlbumCompleteInLibrary({ sizeOnDisk: 1 }), true);
});

test("describeAlbumRequestResult does not claim a blocked album is downloading", () => {
  assert.deepEqual(describeAlbumRequestResult({ status: "queued", jobIds: ["a"] }, "Dummy"), {
    kind: "success",
    message: "Downloading album: Dummy",
  });
  assert.deepEqual(
    describeAlbumRequestResult({ status: "blocked", albumStatus: { recovery: { code: "download_source_missing" } } }, "Dummy"),
    { kind: "info", message: "Added Dummy, but nothing is downloading. Open the album to see why." },
  );
  assert.equal(describeAlbumRequestResult({ albumStatus: { status: "blocked" } }, "Dummy").kind, "info");
});
