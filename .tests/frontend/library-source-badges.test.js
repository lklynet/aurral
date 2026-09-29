import test from "node:test";
import assert from "node:assert/strict";

import {
  describeAlbumBadges,
  trackSourceLabel,
} from "../../frontend/src/utils/librarySourceBadges.js";

const labels = (badges) => badges.map((badge) => badge.label);

test("a mixed-source album shows its manager and one badge per source", () => {
  const badges = describeAlbumBadges({ managedBy: "aurral", sources: ["lidarr", "aurral", "lidarr"] });
  assert.equal(badges.manager.label, "Managed by Aurral");
  assert.deepEqual(labels(badges.sources), ["From Aurral", "From Lidarr"]);
  assert.equal(badges.showTrackSources, true);

  const lidarr = describeAlbumBadges({ managedBy: "lidarr", sources: ["aurral", "lidarr"] });
  assert.equal(lidarr.manager.label, "Managed by Lidarr");
  assert.deepEqual(labels(lidarr.sources), ["From Aurral", "From Lidarr"]);
});

test("an album whose files all come from its manager shows only the manager", () => {
  const badges = describeAlbumBadges({ managedBy: "lidarr", sources: ["lidarr"] });
  assert.equal(badges.manager.label, "Managed by Lidarr");
  assert.deepEqual(badges.sources, []);
  assert.equal(badges.showTrackSources, false);
});

test("files from the other manager are called out even without a mix", () => {
  const badges = describeAlbumBadges({ managedBy: "aurral", sources: ["lidarr"] });
  assert.deepEqual(labels(badges.sources), ["From Lidarr"]);
  assert.equal(badges.showTrackSources, false);
});

test("unmanaged or unknown data produces no invented badges", () => {
  assert.deepEqual(describeAlbumBadges({ managedBy: null, sources: ["aurral"] }), {
    manager: null,
    sources: [],
    showTrackSources: false,
  });
  assert.deepEqual(describeAlbumBadges({ managedBy: "plex", sources: ["plex"] }).sources, []);
  assert.equal(describeAlbumBadges().manager, null);
});

test("each track names the source of the file it plays", () => {
  assert.equal(trackSourceLabel({ source: "aurral", available: true }), "From Aurral");
  assert.equal(trackSourceLabel({ source: "lidarr", available: true }), "From Lidarr");
  assert.equal(trackSourceLabel(null), null);
});
