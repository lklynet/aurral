import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAurralPick,
  getPopularReleaseGroups,
  getReleaseMetric,
} from "../../frontend/src/pages/ArtistDetails/utils.js";

const release = (title, primaryType, extra = {}) => ({
  id: `rg-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  title,
  "primary-type": primaryType,
  "secondary-types": [],
  "first-release-date": null,
  rating: null,
  ...extra,
});

const listened = (listenerCount, listenCount, date) => ({
  listenerCount,
  listenCount,
  "first-release-date": date,
});

const plaidDiscography = () => [
  release("Double Figure", "Album", listened(4906, 67384, "2001-05-26")),
  release("FACT Mix 287: Plaid", "Album", {
    ...listened(3, 10, "2011-09-30"),
    "secondary-types": ["Compilation", "DJ-mix"],
  }),
  release("Feorm Falorx", "Album", listened(996, 8776, "2022-11-11")),
  release("Futura Connect", "Album", {
    ...listened(138, 549, "1999-01-01"),
    "secondary-types": ["Remix"],
  }),
  release("Greedy Baby", "Album", listened(515, 7357, "2006-06-26")),
  release("Not for Threes", "Album", listened(2077, 33892, "1997-10-27")),
  release("Polymer", "Album", listened(1397, 17712, "2019-06-07")),
  release("Reachy Prints", "Album", listened(1286, 17946, "2014-05-19")),
  release("Rest Proof Clockwork", "Album", listened(1954, 31332, "1999-06-19")),
  release("Scintilli", "Album", listened(1220, 21990, "2011-09-05")),
  release("Spokes", "Album", listened(774, 13723, "2003-10-18")),
  release("The Digging Remedy", "Album", listened(2527, 36799, "2016-06-10")),
  release("On Other Hands", "EP", listened(139, 1141, "2016-06-15")),
  release("Undoneson", "Single", { "first-release-date": "1997-09-15" }),
];

const titles = (releaseGroups) => releaseGroups.map((releaseGroup) => releaseGroup.title);

const statusLookup = (statuses) => (id) => {
  const status = statuses[id];
  return status ? { status } : null;
};

test("popular releases are the ones the most ListenBrainz listeners played, not the most plays", () => {
  assert.deepEqual(titles(getPopularReleaseGroups(plaidDiscography(), 6)), [
    "Double Figure",
    "The Digging Remedy",
    "Not for Threes",
    "Rest Proof Clockwork",
    "Polymer",
    "Reachy Prints",
  ]);
});

test("a rating with a handful of votes never outranks a release with more listeners", () => {
  const releaseGroups = [
    release("Obscure Bootleg", "Album", { rating: { value: 9.5, count: 1 } }),
    release("Big Album", "Album", { listenerCount: 40, listenCount: 90 }),
  ];

  assert.deepEqual(titles(getPopularReleaseGroups(releaseGroups, 2)), [
    "Big Album",
    "Obscure Bootleg",
  ]);
  assert.equal(getReleaseMetric(releaseGroups[0]).label, "9.5");
  assert.equal(getReleaseMetric(releaseGroups[0]).type, "rating");
});

test("without any popularity signal, studio albums come first and newer releases lead", () => {
  const releaseGroups = [
    release("Alpha Live", "Album", {
      "secondary-types": ["Live"],
      "first-release-date": "2024-01-01",
    }),
    release("Beta Album", "Album", { "first-release-date": "1999-03-01" }),
    release("Gamma Single", "Single", { "first-release-date": "2025-01-01" }),
    release("Delta Album", "Album", { "first-release-date": "2019-09-09" }),
    release("Epsilon EP", "EP"),
    release("Zeta Album", "Album"),
  ];

  assert.deepEqual(titles(getPopularReleaseGroups(releaseGroups, 6)), [
    "Delta Album",
    "Beta Album",
    "Zeta Album",
    "Epsilon EP",
    "Gamma Single",
    "Alpha Live",
  ]);
});

test("the Aurral pick is the most listened studio album the user has not got or asked for", () => {
  const releaseGroups = plaidDiscography();
  const getAlbumStatus = statusLookup({
    "rg-double-figure": "available",
    "rg-the-digging-remedy": "monitored",
    "rg-not-for-threes": "downloading",
  });

  const pick = buildAurralPick({ releaseGroups, getAlbumStatus });

  assert.equal(pick.title, "Rest Proof Clockwork");
  assert.equal(pick.releaseGroupId, "rg-rest-proof-clockwork");
});

test("the Aurral pick prefers a studio album over a more listened single, mix, or live release", () => {
  const releaseGroups = [
    release("Hit Single", "Single", { listenerCount: 9000, listenCount: 40000 }),
    release("Club Mix", "Album", { "secondary-types": ["DJ-mix"], listenerCount: 8000, listenCount: 30000 }),
    release("Quiet Album", "Album", { listenerCount: 12, listenCount: 50 }),
  ];

  assert.equal(buildAurralPick({ releaseGroups }).title, "Quiet Album");
  assert.equal(
    buildAurralPick({
      releaseGroups,
      getAlbumStatus: statusLookup({ "rg-quiet-album": "available" }),
    }).title,
    "Hit Single",
  );
});

test("the Aurral pick still offers an album that is in Lidarr but unmonitored", () => {
  const releaseGroups = [release("Shelved", "Album", { listenerCount: 5, listenCount: 9 })];

  assert.equal(
    buildAurralPick({
      releaseGroups,
      getAlbumStatus: statusLookup({ "rg-shelved": "unmonitored" }),
    }).title,
    "Shelved",
  );
  assert.equal(
    buildAurralPick({
      releaseGroups,
      getAlbumStatus: statusLookup({ "rg-shelved": "added" }),
    }),
    null,
  );
});
