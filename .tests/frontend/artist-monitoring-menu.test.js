import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArtistMonitoringItems,
  describeArtistAdd,
  describeArtistMonitoring,
  describeArtistMonitoringChange,
  isArtistMonitored,
} from "../../frontend/src/utils/artistMonitoring.js";

const labels = (items) => items.map((item) => item.label);

test("only Lidarr offers Existing albums and Missing albums", () => {
  const selected = [];
  const aurral = buildArtistMonitoringItems({ manager: "aurral", current: "future", onSelect: (option) => selected.push(option) });
  const lidarr = buildArtistMonitoringItems({ manager: "lidarr", current: "none", onSelect: () => {} });

  assert.deepEqual(labels(aurral), ["Not monitored", "All albums", "Future albums", "Latest album", "First album"]);
  assert.deepEqual(labels(lidarr), ["Not monitored", "Existing albums", "All albums", "Future albums", "Missing albums", "Latest album", "First album"]);
  assert.deepEqual(aurral.filter((item) => item.selected).map((item) => item.label), ["Future albums"]);
  assert.deepEqual(lidarr.filter((item) => item.selected).map((item) => item.label), ["Not monitored"]);
  aurral[1].onSelect();
  assert.deepEqual(selected, ["all"]);
});

test("an artist not yet in Lidarr reads as not monitored", () => {
  assert.equal(isArtistMonitored({ manager: "lidarr", added: false, monitorOption: "all" }), false);
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: false, monitorOption: "all" }), "Not monitored");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: "existing" }), "Existing albums");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: null }), "Custom");
  assert.equal(isArtistMonitored({ manager: "lidarr", added: true, monitorOption: null }), true);
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: true, monitorOption: "none" }), "Not monitored");
});

test("results never name a manager", () => {
  const name = "Boards of Canada";
  assert.equal(describeArtistMonitoringChange({ name, option: "none" }), "Stopped monitoring Boards of Canada");
  assert.equal(
    describeArtistMonitoringChange({
      name,
      option: "all",
      response: { monitoring: { mode: "all", releaseGroupIds: ["a", "b"], skipped: [], queued: true } },
    }),
    "Monitoring Boards of Canada: All albums. Queued 2 albums for download",
  );
  assert.equal(describeArtistAdd({ name, monitorOption: "existing" }), "Monitoring Boards of Canada: Existing albums");
  assert.equal(describeArtistAdd({ name }), "Added Boards of Canada to your library");
});
