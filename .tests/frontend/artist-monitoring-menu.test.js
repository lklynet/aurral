import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArtistAddMenuItems,
  buildManagerMonitoringItems,
  describeArtistAdd,
  describeArtistMonitoringChange,
  describeArtistMonitoring,
} from "../../frontend/src/utils/artistMonitoring.js";

const labels = (items) => items.map((item) => item.label);

test("each manager's button lists only that manager's choices, with the current one checked", () => {
  const selected = [];
  const aurral = buildManagerMonitoringItems({
    manager: "aurral",
    current: "future",
    onSelect: (option) => selected.push(option),
  });
  const lidarr = buildManagerMonitoringItems({ manager: "lidarr", current: null, onSelect: () => {} });

  assert.deepEqual(labels(aurral), ["Unmonitored", "All albums", "Future albums", "Missing albums", "Latest album", "First album"]);
  assert.deepEqual(aurral.filter((item) => item.selected).map((item) => item.id), ["aurral:future"]);
  assert.equal(aurral.every((item) => item.radio), true);
  assert.deepEqual(labels(lidarr), [
    "None",
    "Existing albums",
    "All albums",
    "Future albums",
    "Missing albums",
    "Latest album",
    "First album",
  ]);
  assert.equal(lidarr.some((item) => item.selected), false);
  aurral[0].onSelect();
  assert.deepEqual(selected, ["none"]);
});

test("adding offers Lidarr without monitoring but never a do-nothing Aurral choice", () => {
  const lidarr = buildManagerMonitoringItems({ manager: "lidarr", adding: true, onSelect: () => {} });
  const aurral = buildManagerMonitoringItems({ manager: "aurral", adding: true, onSelect: () => {} });

  assert.equal(lidarr[0].label, "Add without monitoring");
  assert.equal(lidarr.some((item) => item.radio), false);
  assert.equal(aurral.some((item) => item.id === "aurral:none"), false);
});

test("the button reads the active manager's state", () => {
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: false, monitorOption: "none" }), "Unmonitored");
  assert.equal(describeArtistMonitoring({ manager: "aurral", added: true, monitorOption: "latest" }), "Latest album");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: false, monitorOption: "none" }), "Add to Lidarr");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: "existing" }), "Existing albums");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: "none" }), "None");
  assert.equal(describeArtistMonitoring({ manager: "lidarr", added: true, monitorOption: null }), "Custom");
});

test("card add menus list the active manager's choices", () => {
  const added = [];
  const lidarr = buildArtistAddMenuItems({ manager: "lidarr", onAdd: (manager, option) => added.push([manager, option]) });
  const aurral = buildArtistAddMenuItems({ manager: "aurral", onAdd: (manager, option) => added.push([manager, option]) });

  assert.equal(lidarr[0].label, "Add without monitoring");
  assert.equal(aurral.some((item) => item.id === "aurral:none"), false);
  aurral[0].onSelect();
  assert.deepEqual(added, [["aurral", "all"]]);
});

test("results name the manager, the albums, and anything Aurral queued", () => {
  const name = "Boards of Canada";
  assert.equal(
    describeArtistMonitoringChange({ name, manager: "aurral", option: "none" }),
    "Aurral no longer monitors Boards of Canada",
  );
  assert.equal(
    describeArtistMonitoringChange({
      name,
      manager: "aurral",
      option: "all",
      response: { monitoring: { mode: "all", releaseGroupIds: ["a", "b"], skipped: [], queued: true } },
    }),
    "Aurral monitors Boards of Canada: All albums. Queued 2 albums for download",
  );
  assert.equal(
    describeArtistAdd({ name, manager: "lidarr", monitorOption: "none" }),
    "Added Boards of Canada to Lidarr without monitoring",
  );
  assert.equal(
    describeArtistAdd({ name, manager: "lidarr", monitorOption: "existing" }),
    "Added Boards of Canada to Lidarr: Existing albums",
  );
});
