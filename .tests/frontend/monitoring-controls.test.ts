import { FACTORY_MONITOR_RULES } from "../../backend/services/monitoring.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  canDownloadAlbum,
  describeAlbumMonitoringResult,
  describeMonitoringError,
  getAlbumMonitoredState,
  getMonitoringMenuAction,
  shouldConfirmUnmonitor,
  summarizeMonitoring,
} from "../../frontend/src/utils/monitoring.ts";

test("summary counts queued releases and top tracks", () => {
  const monitored = { monitored: true, rules: { ...FACTORY_MONITOR_RULES, newReleases: true } };
  assert.equal(
    summarizeMonitoring(
      { releaseGroupIds: ["rg1"], topTracks: [], skipped: [], queued: true },
      monitored,
    ).headline,
    "Queued 1 release for download",
  );
  assert.equal(
    summarizeMonitoring(
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
    summarizeMonitoring(
      { releaseGroupIds: [], topTracks: [{ title: "a" }], skipped: [], queued: true },
      monitored,
    ).headline,
    "Queued 1 top track for download",
  );
});

test("summary says what happens when nothing was queued", () => {
  const empty = { releaseGroupIds: [], topTracks: [], skipped: [], queued: false };
  assert.equal(summarizeMonitoring(empty, { monitored: false }).headline, "Monitoring turned off");
  assert.equal(
    summarizeMonitoring(empty, {
      monitored: true,
      rules: { ...FACTORY_MONITOR_RULES, newReleases: true },
    }).headline,
    "Watching for new releases",
  );
  assert.equal(
    summarizeMonitoring(empty, {
      monitored: true,
      rules: { ...FACTORY_MONITOR_RULES, newReleases: false },
    }).headline,
    "Nothing new to download",
  );
  assert.equal(summarizeMonitoring(undefined).headline, "Nothing new to download");
});

test("summary lists skipped releases by reason with counts and keeps unknown reasons", () => {
  const summary = summarizeMonitoring(
    {
      releaseGroupIds: ["rg1"],
      skipped: [
        { reason: "complete" },
        { reason: "complete" },
        { reason: "covered" },
        { reason: "excluded" },
        { reason: "unmonitored" },
        { reason: "brand_new_reason" },
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
    "1 skipped",
    "Top tracks are unavailable right now. Aurral tries again tomorrow",
  ]);
  assert.match(summary.message, /^Queued 1 release for download\. 2 already in your library\./);
});

const requestError = (status: number, data: Record<string, string>) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

test("metadata_unavailable explains that monitoring did not change", () => {
  const message = describeMonitoringError(
    requestError(503, {
      code: "metadata_unavailable",
      error: "Artist releases are unavailable; monitoring was not changed",
    }),
  );
  assert.match(message, /monitoring was not changed/i);
  assert.match(message, /try again/i);
});

test("other monitoring errors keep the server message", () => {
  assert.equal(
    describeMonitoringError(requestError(503, { message: "Service is busy" })),
    "Service is busy",
  );
  assert.equal(
    describeMonitoringError(
      requestError(400, { code: "unsupported_monitor_mode", error: "Bad mode" }),
    ),
    "Bad mode",
  );
  assert.equal(describeMonitoringError(new Error("Network Error")), "Network Error");
  assert.equal(describeMonitoringError({}, "Failed to update"), "Failed to update");
});

test("album monitored state follows the server for Aurral albums", () => {
  assert.equal(
    getAlbumMonitoredState({ managed: true, monitored: true, monitorMode: "monitored" }),
    true,
  );
  assert.equal(getAlbumMonitoredState({ managed: true, monitored: true, monitorMode: null }), true);
  assert.equal(
    getAlbumMonitoredState({ managed: true, monitored: false, monitorMode: "unmonitored" }),
    false,
  );
  assert.equal(
    getAlbumMonitoredState({ managed: true, monitored: true, monitorMode: "unmonitored" }),
    false,
  );
  assert.equal(getAlbumMonitoredState({ managed: true }), false);
});

test("album monitored state reads the library page shape", () => {
  assert.equal(
    getAlbumMonitoredState({
      managed: true,
      monitorMode: null,
      metadata: { monitored: true },
    }),
    true,
  );
  assert.equal(
    getAlbumMonitoredState({
      managed: true,
      monitorMode: null,
      metadata: { monitored: false },
    }),
    false,
  );
});

test("a server response for the album overrides the stored library metadata", () => {
  assert.equal(
    getAlbumMonitoredState({
      managed: true,
      monitored: false,
      monitorMode: "unmonitored",
      metadata: { monitored: true },
    }),
    false,
  );
  assert.equal(
    getAlbumMonitoredState({
      managed: true,
      monitored: true,
      monitorMode: "monitored",
      metadata: { monitored: false },
    }),
    true,
  );
});

test("albums that Aurral does not manage have no monitored toggle", () => {
  assert.equal(getAlbumMonitoredState({ managed: false, monitored: true }), null);
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
    managed: true,
    monitored: false,
    monitorMode: null,
    releaseGroupMbid: "rg",
  };
  assert.equal(canDownloadAlbum(album, { hasMissingTracks: true }), true);
  assert.equal(canDownloadAlbum(album, { hasMissingTracks: false }), false);
  assert.equal(canDownloadAlbum({ ...album, monitored: true }, { hasMissingTracks: true }), false);
  assert.equal(
    canDownloadAlbum({ ...album, releaseGroupMbid: null }, { hasMissingTracks: true }),
    false,
  );
  assert.equal(canDownloadAlbum({ ...album, managed: false }, { hasMissingTracks: true }), false);
});

test("unmonitoring asks first only while downloads are unfinished", () => {
  assert.equal(shouldConfirmUnmonitor("queued"), true);
  assert.equal(shouldConfirmUnmonitor("downloading"), true);
  for (const status of [
    "complete",
    "partial",
    "missing",
    "failed",
    "cancelled",
    "blocked",
  ] as const) {
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
