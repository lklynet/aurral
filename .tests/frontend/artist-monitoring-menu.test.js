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

test("Aurral artists are monitored or not and open their rules, while Lidarr keeps its monitor options", () => {
  const selected = [];
  const edits = [];
  const aurral = buildArtistMonitoringItems({
    manager: "aurral",
    state: { manager: "aurral", added: true, monitored: true, useDefault: false },
    onSelect: (request) => selected.push(request),
    onEditRules: () => edits.push("rules"),
  });
  const lidarr = buildArtistMonitoringItems({
    manager: "lidarr",
    state: { manager: "lidarr", added: true, monitorOption: "future" },
    onSelect: (request) => selected.push(request),
  });

  assert.deepEqual(labels(aurral), ["Monitored", "Not monitored", "Monitoring rules…"]);
  assert.deepEqual(aurral.filter((item) => item.selected).map((item) => item.label), ["Monitored"]);
  assert.deepEqual(labels(lidarr), ["Not monitored", "Existing albums", "All albums", "Future albums", "Missing albums", "Latest album", "First album"]);
  assert.deepEqual(lidarr.filter((item) => item.selected).map((item) => item.label), ["Future albums"]);

  aurral[1].onSelect();
  aurral[2].onSelect();
  lidarr[2].onSelect();
  assert.deepEqual(selected, [{ monitoring: { monitored: false } }, { monitorOption: "all" }]);
  assert.deepEqual(edits, ["rules"]);
});

test("an artist not yet in the library reads as not monitored", () => {
  assert.equal(isArtistMonitored({ manager: "lidarr", added: false, monitorOption: "all" }), false);
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: false, monitorOption: "all" }), "Not monitored");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: "existing" }), "Existing albums");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: null }), "Custom");
  assert.equal(isArtistMonitored({ manager: "lidarr", added: true, monitorOption: null }), true);
  assert.equal(isArtistMonitored({ manager: "aurral", added: false, monitored: true }), false);
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: true, monitored: false }), "Not monitored");
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: true, monitored: true, useDefault: true }), "Monitored");
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: true, monitored: true, useDefault: false }), "Custom rules");
});

test("results never name a manager", () => {
  const name = "Boards of Canada";
  assert.equal(
    describeArtistMonitoringChange({ name, request: { monitoring: { monitored: false } } }),
    "Stopped monitoring Boards of Canada",
  );
  assert.equal(
    describeArtistMonitoringChange({
      name,
      request: { monitoring: { monitored: true, useDefault: false } },
      response: {
        monitored: true,
        useDefault: false,
        rules: { newReleases: true },
        monitoring: { releaseGroupIds: ["a", "b"], topTracks: [{ title: "Roygbiv" }], skipped: [], queued: true },
      },
    }),
    "Monitoring Boards of Canada with custom rules. Queued 2 releases and 1 top track for download",
  );
  assert.equal(
    describeArtistMonitoringChange({ name, request: { monitorOption: "none" } }),
    "Stopped monitoring Boards of Canada",
  );
  assert.equal(
    describeArtistMonitoringChange({ name, request: { monitorOption: "latest" } }),
    "Monitoring Boards of Canada: Latest album",
  );
  assert.equal(describeArtistAdd({ name, monitorOption: "existing" }), "Monitoring Boards of Canada: Existing albums");
  assert.equal(describeArtistAdd({ name }), "Added Boards of Canada to your library");
});
