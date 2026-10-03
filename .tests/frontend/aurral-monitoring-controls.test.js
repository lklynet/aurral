import test from "node:test";
import assert from "node:assert/strict";

import { getMonitorOptionsForManager } from "../../frontend/src/utils/libraryDestination.js";
import {
  MONITOR_OPTIONS,
  canDownloadAurralAlbum,
  describeAlbumMonitoringResult,
  describeArtistMonitoringResult,
  describeAurralMonitoringError,
  getAlbumMonitoredState,
  getMonitoringMenuAction,
  resolveCurrentMonitorOption,
  shouldConfirmUnmonitor,
  summarizeAurralMonitoring,
} from "../../frontend/src/utils/aurralMonitoring.js";

const values = (options) => options.map((option) => option.value);

test("Aurral artists never get existing or missing, which Aurral treats as all", () => {
  assert.deepEqual(values(getMonitorOptionsForManager(MONITOR_OPTIONS, "aurral")), [
    "none",
    "all",
    "future",
    "latest",
    "first",
  ]);
});

test("Lidarr artists keep existing among their monitor options", () => {
  const options = getMonitorOptionsForManager(MONITOR_OPTIONS, "lidarr");
  assert.ok(values(options).includes("existing"));
  assert.equal(options.length, 7);
});

test("summary reports a single queued album", () => {
  const summary = summarizeAurralMonitoring({
    mode: "latest",
    releaseGroupIds: ["rg1"],
    skipped: [],
    queued: true,
  });
  assert.equal(summary.headline, "Queued 1 album for download");
  assert.deepEqual(summary.details, []);
});

test("summary counts queued albums from the planned release groups", () => {
  const summary = summarizeAurralMonitoring({
    mode: "all",
    releaseGroupIds: ["rg1", "rg2", "rg3"],
    skipped: [],
    queued: true,
  });
  assert.equal(summary.headline, "Queued 3 albums for download");
});

test("summary lists skipped albums by reason with counts", () => {
  const summary = summarizeAurralMonitoring({
    mode: "all",
    releaseGroupIds: ["rg1"],
    skipped: [
      { releaseGroupId: "rg2", reason: "complete" },
      { releaseGroupId: "rg3", reason: "complete" },
      { releaseGroupId: "rg4", reason: "unmonitored" },
      { releaseGroupId: "rg5", reason: "managed_by_lidarr" },
    ],
    queued: true,
  });
  assert.deepEqual(summary.details, [
    "2 already in your library",
    "1 skipped because you unmonitored it",
    "1 managed by Lidarr",
  ]);
  assert.equal(
    summary.message,
    "Queued 1 album for download. 2 already in your library. 1 skipped because you unmonitored it. 1 managed by Lidarr",
  );
});

test("summary does not hide skips with an unknown reason", () => {
  const summary = summarizeAurralMonitoring({
    mode: "missing",
    releaseGroupIds: [],
    skipped: [{ releaseGroupId: "rg9", reason: "brand_new_reason" }],
    queued: false,
  });
  assert.equal(summary.headline, "No albums to queue");
  assert.deepEqual(summary.details, ["1 skipped"]);
});

test("summary says monitoring was turned off for none", () => {
  const summary = summarizeAurralMonitoring({
    mode: "none",
    releaseGroupIds: [],
    skipped: [],
    queued: false,
  });
  assert.equal(summary.headline, "Monitoring turned off");
});

test("summary says future monitoring is watching when nothing was queued", () => {
  const summary = summarizeAurralMonitoring({
    mode: "future",
    releaseGroupIds: [],
    skipped: [],
    queued: false,
  });
  assert.equal(summary.headline, "Watching for new releases");
});

test("summary tolerates a response without monitoring details", () => {
  assert.equal(summarizeAurralMonitoring(undefined).headline, "No albums to queue");
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
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: "monitored" }), true);
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: null }), true);
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral", monitored: false, monitorMode: "unmonitored" }), false);
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral", monitored: true, monitorMode: "unmonitored" }), false);
  assert.equal(getAlbumMonitoredState({ managedBy: "aurral" }), false);
});

test("album monitored state reads the library page shape", () => {
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitorMode: null, metadata: { monitored: true } }),
    true,
  );
  assert.equal(
    getAlbumMonitoredState({ managedBy: "aurral", monitorMode: null, metadata: { monitored: false } }),
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
  const album = { managedBy: "aurral", monitored: false, monitorMode: null, releaseGroupMbid: "rg" };
  assert.equal(canDownloadAurralAlbum(album, { hasMissingTracks: true }), true);
  assert.equal(canDownloadAurralAlbum(album, { hasMissingTracks: false }), false);
  assert.equal(canDownloadAurralAlbum({ ...album, monitored: true }, { hasMissingTracks: true }), false);
  assert.equal(canDownloadAurralAlbum({ ...album, releaseGroupMbid: null }, { hasMissingTracks: true }), false);
  assert.equal(canDownloadAurralAlbum({ ...album, managedBy: "lidarr" }, { hasMissingTracks: true }), false);
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
    describeAlbumMonitoringResult({ monitored: false, cancelledJobIds: ["a", "b"], cleanupFailed: false }),
    { message: "Album unmonitored. Cancelled 2 downloads.", warning: false },
  );
  assert.deepEqual(
    describeAlbumMonitoringResult({ monitored: false, cancelledJobIds: ["a"], cleanupFailed: false }),
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

test("Aurral artist monitoring result takes state and message from the server", () => {
  const result = describeArtistMonitoringResult({
    id: 7,
    monitored: true,
    monitorOption: "latest",
    monitoring: { mode: "latest", releaseGroupIds: ["rg1"], skipped: [], queued: true },
  });
  assert.deepEqual(result.patch, { monitored: true, monitorOption: "latest" });
  assert.equal(result.message, "Queued 1 album for download");
});

test("turning Aurral monitoring off leaves the artist unmonitored", () => {
  const result = describeArtistMonitoringResult({
    monitored: false,
    monitorOption: "none",
    monitoring: { mode: "none", releaseGroupIds: [], skipped: [], queued: false },
  });
  assert.deepEqual(result.patch, { monitored: false, monitorOption: "none" });
  assert.equal(result.message, "Monitoring turned off");
});

test("Lidarr artist updates carry no Aurral monitoring result", () => {
  assert.equal(describeArtistMonitoringResult({ id: 3, monitorOption: "all" }), null);
  assert.equal(describeArtistMonitoringResult(undefined), null);
});

test("current monitor option comes from the stored artist value", () => {
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, monitorOption: "latest" }, "aurral"),
    "latest",
  );
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, addOptions: { monitor: "first" } }, "aurral"),
    "first",
  );
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, monitorNewItems: "future" }, "lidarr"),
    "future",
  );
});

test("current monitor option is none for an unmonitored or absent artist", () => {
  assert.equal(resolveCurrentMonitorOption(null, "aurral"), "none");
  assert.equal(
    resolveCurrentMonitorOption({ monitored: false, monitorOption: "all" }, "aurral"),
    "none",
  );
  assert.equal(resolveCurrentMonitorOption({ monitored: false }, "lidarr"), "none");
});

test("current monitor option keeps the legacy fallback for monitored Lidarr artists", () => {
  assert.equal(resolveCurrentMonitorOption({ monitored: true }, "lidarr"), "all");
});

test("a stored option the manager does not offer is not remapped", () => {
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, monitorOption: "existing" }, "aurral"),
    null,
  );
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, monitorOption: "existing" }, "lidarr"),
    "existing",
  );
  assert.equal(
    resolveCurrentMonitorOption({ monitored: true, monitorOption: "sometimes" }, "lidarr"),
    null,
  );
});
