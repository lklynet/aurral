import { FACTORY_MONITOR_RULES } from "../../backend/services/aurralMonitoring.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  buildArtistMonitoringItems,
  describeArtistMonitoring,
  describeArtistMonitoringChange,
  isArtistMonitored,
} from "../../frontend/src/utils/artistMonitoring.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const labels = (
  items: (
    | {
        id: string;
        label: string;
        radio: boolean;
        selected: boolean;
        onSelect: () => unknown;
        separatorBefore?: undefined;
        closeBeforeSelect?: undefined;
      }
    | {
        id: string;
        label: string;
        separatorBefore: boolean;
        closeBeforeSelect: boolean;
        onSelect: () => void;
        radio?: undefined;
        selected?: undefined;
      }
  )[],
) => items.map((item) => item.label);

test("an artist is monitored or not, and the menu opens its rules", () => {
  const selected: { monitoring: { monitored: boolean } }[] = [];
  const edits: string[] = [];
  const items = buildArtistMonitoringItems({
    state: { added: true, monitored: true, useDefault: false },
    onSelect: (request) => selected.push(request),
    onEditRules: () => edits.push("rules"),
  });

  assert.deepEqual(labels(items), ["Monitored", "Not monitored", "Monitoring rules…"]);
  assert.deepEqual(
    items.filter((item) => item.selected).map((item) => item.label),
    ["Monitored"],
  );

  requireFixture(items[1]).onSelect();
  requireFixture(items[2]).onSelect();
  assert.deepEqual(selected, [{ monitoring: { monitored: false } }]);
  assert.deepEqual(edits, ["rules"]);
});

test("an artist not yet in the library reads as not monitored", () => {
  assert.equal(isArtistMonitored({ added: false, monitored: true }), false);
  assert.equal(describeArtistMonitoring({ added: true, monitored: false }), "Not monitored");
  assert.equal(
    describeArtistMonitoring({ added: true, monitored: true, useDefault: true }),
    "Monitored",
  );
  assert.equal(
    describeArtistMonitoring({ added: true, monitored: true, useDefault: false }),
    "Custom rules",
  );
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
        rules: { ...FACTORY_MONITOR_RULES, newReleases: true },
        monitoring: {
          releaseGroupIds: ["a", "b"],
          topTracks: [{ title: "Roygbiv" }],
          skipped: [],
          queued: true,
        },
      },
    }),
    "Monitoring Boards of Canada with custom rules. Queued 2 releases and 1 top track for download",
  );
});
