import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  canDownloadAurralAlbum,
  describeAlbumMonitoringResult,
  describeAurralMonitoringError,
  describeKeepFileResult,
  getAlbumMonitoredState,
  getMonitoringMenuAction,
  shouldConfirmUnmonitor,
  summarizeAurralMonitoring,
} from "../../frontend/src/utils/aurralMonitoring.js";

test("summary counts queued releases and top tracks", () => {
  const monitored = { monitored: true, rules: { newReleases: true } };
  assert.equal(
    summarizeAurralMonitoring(
      { releaseGroupIds: ["rg1"], topTracks: [], skipped: [], queued: true },
      monitored,
    ).headline,
    "Queued 1 release for download",
  );
  assert.equal(
    summarizeAurralMonitoring(
      {
        releaseGroupIds: ["rg1", "rg2"],
        topTracks: [{ title: "a" }, { title: "b" }],
        skipped: [],
        queued: true,
      },
      monitored,
    ).headline,
    "Queued 2 releases and 2 top tracks for download",
  );
  assert.equal(
    summarizeAurralMonitoring(
      { releaseGroupIds: [], topTracks: [{ title: "a" }], skipped: [], queued: true },
      monitored,
    ).headline,
    "Queued 1 top track for download",
  );
});

test("summary says what happens when nothing was queued", () => {
  const empty = { releaseGroupIds: [], topTracks: [], skipped: [], queued: false };
  assert.equal(
    summarizeAurralMonitoring(empty, { monitored: false }).headline,
    "Monitoring turned off",
  );
  assert.equal(
    summarizeAurralMonitoring(empty, { monitored: true, rules: { newReleases: true } }).headline,
    "Watching for new releases",
  );
  assert.equal(
    summarizeAurralMonitoring(empty, { monitored: true, rules: { newReleases: false } }).headline,
    "Nothing new to download",
  );
  assert.equal(summarizeAurralMonitoring(undefined).headline, "Nothing new to download");
});

test("summary lists skipped releases by reason with counts and keeps unknown reasons", () => {
  const summary = summarizeAurralMonitoring(
    {
      releaseGroupIds: ["rg1"],
      skipped: [
        { releaseGroupId: "rg2", reason: "complete" },
        { releaseGroupId: "rg3", reason: "complete" },
        { releaseGroupId: "rg4", reason: "covered" },
        { releaseGroupId: "rg5", reason: "excluded" },
        { releaseGroupId: "rg6", reason: "unmonitored" },
        { releaseGroupId: "rg7", reason: "managed_by_lidarr" },
        { releaseGroupId: "rg8", reason: "brand_new_reason" },
      ],
      topTracksError: "Top tracks are unavailable right now. Aurral tries again tomorrow.",
      queued: true,
    },
    { monitored: true },
  );
  assert.deepEqual(summary.details, [
    "2 already in your library",
    "1 skipped because another release has its songs",
    "1 skipped because you removed it",
    "1 skipped because you unmonitored it",
    "1 managed by Lidarr",
    "1 skipped",
    "Top tracks are unavailable right now. Aurral tries again tomorrow",
  ]);
  assert.match(summary.message, /^Queued 1 release for download\. 2 already in your library\./);
});

test("metadata_unavailable explains that monitoring did not change", () => {
  const message = describeAurralMonitoringError({
    response: {
      status: 503,
      data: {
        code: "metadata_unavailable",
        error: "Artist releases are unavailable; monitoring was not changed",
      },
    },
  });
  assert.match(message, /monitoring was not changed/i);
  assert.match(message, /try again/i);
});

test("other monitoring errors keep the server message", () => {
  assert.equal(
    describeAurralMonitoringError({
      response: { status: 503, data: { message: "Service is busy" } },
    }),
    "Service is busy",
  );
  assert.equal(
    describeAurralMonitoringError({
      response: { status: 400, data: { code: "unsupported_monitor_mode", error: "Bad mode" } },
    }),
    "Bad mode",
  );
  assert.equal(describeAurralMonitoringError(new Error("Network Error")), "Network Error");
  assert.equal(describeAurralMonitoringError({}, "Failed to update"), "Failed to update");
});

test("album monitored state follows the server for Aurral albums", () => {
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: "monitored" }),
    true,
  );
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: null }),
    true,
  );
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitored: false, monitorMode: "unmonitored" }),
    false,
  );
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: "unmonitored" }),
    false,
  );
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral" }), false);
});

test("album monitored state reads the library page shape", () => {
  assert.equal(
    getAlbumMonitoredState({
      managedBy: "aurral",
      monitorMode: null,
      metadata: { monitored: true },
    }),
    true,
  );
  assert.equal(
    getAlbumMonitoredState({
      managedBy: "aurral",
      monitorMode: null,
      metadata: { monitored: false },
    }),
    false,
  );
});

test("a server response for the album overrides the stored library metadata", () => {
  assert.equal(
    getAlbumMonitoredState({
      managedBy: "aurral",
      monitored: false,
      monitorMode: "unmonitored",
      metadata: { monitored: true },
    }),
    false,
  );
  assert.equal(
    getAlbumMonitoredState({
      managedBy: "aurral",
      monitored: true,
      monitorMode: "monitored",
      metadata: { monitored: false },
    }),
    true,
  );
});

test("albums that Aurral does not manage have no monitored toggle", () => {
  assert.equal(getAlbumMonitoredState({ managedBy: "lidarr", monitored: true }), null);
  assert.equal(getAlbumMonitoredState({ monitored: true }), null);
  assert.equal(getAlbumMonitoredState(null), null);
});

test("anything with missing files is monitored by downloading it, so the menu only offers stopping", () => {
  assert.equal(getMonitoringMenuAction({ monitored: true, hasMissing: true }), "stop");
  assert.equal(getMonitoringMenuAction({ monitored: true, hasMissing: false }), "stop");
  assert.equal(getMonitoringMenuAction({ monitored: false, hasMissing: true }), null);
  assert.equal(getMonitoringMenuAction({ monitored: false, hasMissing: false }), "monitor");
});

test("the album download is offered for unmonitored Aurral albums with missing tracks", () => {
  const album = {
    managedBy: "aurral",
    monitored: false,
    monitorMode: null,
    releaseGroupMbid: "rg",
  };
  assert.equal(canDownloadAurralAlbum(album, { hasMissingTracks: true }), true);
  assert.equal(canDownloadAurralAlbum(album, { hasMissingTracks: false }), false);
  assert.equal(
    canDownloadAurralAlbum({ ...album, monitored: true }, { hasMissingTracks: true }),
    false,
  );
  assert.equal(
    canDownloadAurralAlbum({ ...album, releaseGroupMbid: null }, { hasMissingTracks: true }),
    false,
  );
  assert.equal(
    canDownloadAurralAlbum({ ...album, managedBy: "lidarr" }, { hasMissingTracks: true }),
    false,
  );
});

test("unmonitoring asks first only while downloads are unfinished", () => {
  assert.equal(shouldConfirmUnmonitor("queued"), true);
  assert.equal(shouldConfirmUnmonitor("downloading"), true);
  for (const status of ["complete", "partial", "missing", "failed", "cancelled", "blocked"]) {
    assert.equal(shouldConfirmUnmonitor(status), false, String(status));
  }
});

test("unmonitoring asks first when the download status is unknown", () => {
  assert.equal(shouldConfirmUnmonitor(undefined), true);
  assert.equal(shouldConfirmUnmonitor(null), true);
});

test("unmonitoring result reports cancelled downloads", () => {
  assert.deepEqual(
    describeAlbumMonitoringResult({
      monitored: false,
      cancelledJobIds: ["a", "b"],
      cleanupFailed: false,
    }),
    { message: "Album unmonitored. Cancelled 2 downloads.", warning: false },
  );
  assert.deepEqual(
    describeAlbumMonitoringResult({
      monitored: false,
      cancelledJobIds: ["a"],
      cleanupFailed: false,
    }),
    { message: "Album unmonitored. Cancelled 1 download.", warning: false },
  );
});

test("unmonitoring result warns when the download client cleanup failed", () => {
  const result = describeAlbumMonitoringResult({
    monitored: false,
    cancelledJobIds: ["a"],
    cleanupFailed: true,
  });
  assert.equal(result.warning, true);
  assert.match(result.message, /download client/i);
});

test("keeping a file warns when the upgrade in progress may still be running", () => {
  const cancelled = describeKeepFileResult(
    { keepFile: true, cancelledJobIds: ["a"], cleanupFailed: false },
    "Roygbiv",
  );
  assert.deepEqual(cancelled, {
    message:
      "Keeping Roygbiv. Aurral won't replace it with an upgrade, and the upgrade in progress was cancelled.",
    warning: false,
  });
  const stuck = describeKeepFileResult(
    { keepFile: true, cancelledJobIds: ["a"], cleanupFailed: true },
    "Roygbiv",
  );
  assert.equal(stuck.warning, true);
  assert.match(stuck.message, /download client/i);
  assert.doesNotMatch(stuck.message, /was cancelled/);
});

test("unmonitoring an idle album reports no cancellations", () => {
  assert.deepEqual(
    describeAlbumMonitoringResult({ monitored: false, cancelledJobIds: [], cleanupFailed: false }),
    { message: "Album unmonitored", warning: false },
  );
});

test("monitoring an album is reported as monitored", () => {
  assert.deepEqual(describeAlbumMonitoringResult({ monitored: true }), {
    message: "Album monitored",
    warning: false,
  });
});
