import test from "node:test";
import assert from "node:assert/strict";
import {
  bypassBannedArtistTerm,
  buildFlowSearchTiers,
  buildTrackQueryVariants,
  selectRankedMatchAttempts,
  stripReleaseTypeSuffix,
  stripVersionSuffix,
} from "../../backend/services/weeklyFlow/weeklyFlowSoulseekSearch.js";
import { toPipelineCandidate } from "../../backend/services/trackMatching/sourceSearch.js";

test("bypassBannedArtistTerm replaces the first character of each artist word", () => {
  assert.equal(bypassBannedArtistTerm("Franz Ferdinand"), "*ranz *erdinand");
  assert.equal(bypassBannedArtistTerm("*ranz *erdinand"), "*ranz *erdinand");
  assert.equal(bypassBannedArtistTerm("A"), "A");
  assert.equal(bypassBannedArtistTerm(""), "");
});

test("stripReleaseTypeSuffix removes terminal release metadata only", () => {
  assert.equal(
    stripReleaseTypeSuffix("Object Permanence - Single"),
    "Object Permanence",
  );
  assert.equal(stripReleaseTypeSuffix("Some Release (EP)"), "Some Release");
  assert.equal(stripReleaseTypeSuffix("Single"), "Single");
  assert.equal(stripReleaseTypeSuffix("Single Mothers"), "Single Mothers");
});

test("stripVersionSuffix removes trailing version descriptors only", () => {
  assert.equal(stripVersionSuffix("Never Again - Single Mix"), "Never Again");
  assert.equal(stripVersionSuffix("Look at me now - Radio Edit"), "Look at me now");
  assert.equal(stripVersionSuffix("Flying Free - Original Mix"), "Flying Free");
  assert.equal(stripVersionSuffix("Back in Black - Live"), "Back in Black");
  assert.equal(stripVersionSuffix("Highway - Star City"), "Highway - Star City");
  assert.equal(stripVersionSuffix("Teardrop"), "Teardrop");
});

test("buildTrackQueryVariants adds stripped and parenthesized variants", () => {
  const variants = buildTrackQueryVariants("Never Again - Single Mix");
  assert.ok(variants.includes("Never Again - Single Mix"));
  assert.ok(variants.includes("Never Again"));
});

test("buildFlowSearchTiers uses a short album-first plan", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });

  assert.equal(tiers[0]?.name, "base_album");
  assert.ok(tiers[0].queries.includes("Massive Attack Mezzanine 1998"));
  assert.ok(
    tiers.some(
      (tier) =>
        tier.name === "wildcard_album" &&
        tier.queries.includes("*assive *ttack Mezzanine 1998"),
    ),
  );
  assert.ok(
    tiers.some(
      (tier) =>
        tier.name === "album_track" && tier.queries.includes("Mezzanine Teardrop"),
    ),
  );
});

test("buildFlowSearchTiers adds an album-only query after artist album tiers", () => {
  const context = {
    artistName: "Rihanna",
    trackName: "Umbrella",
    albumName: "Good Girl Gone Bad",
    releaseYear: "2007",
  };
  const tiers = buildFlowSearchTiers(context);

  const wildcardAlbumIndex = tiers.findIndex((tier) => tier.name === "wildcard_album");
  const albumOnlyIndex = tiers.findIndex((tier) => tier.name === "album_only");
  const albumTrackIndex = tiers.findIndex((tier) => tier.name === "album_track");
  const primaryTrack = tiers.find((tier) => tier.name === "primary_track");

  assert.deepEqual(tiers[albumOnlyIndex]?.queries, ["Good Girl Gone Bad"]);
  assert.equal(tiers[albumOnlyIndex]?.tier, 2);
  assert.ok(wildcardAlbumIndex < albumOnlyIndex);
  assert.ok(albumOnlyIndex < albumTrackIndex);
  assert.equal(tiers[albumTrackIndex]?.tier, 3);
  assert.equal(primaryTrack?.tier, 4);
});

test("buildFlowSearchTiers adds album-only search without an artist and skips blank albums", () => {
  const withoutArtist = buildFlowSearchTiers({
    artistName: "",
    trackName: "Umbrella",
    albumName: "Good Girl Gone Bad",
    releaseYear: "2007",
  });
  const withoutAlbum = buildFlowSearchTiers({
    artistName: "Rihanna",
    trackName: "Umbrella",
    albumName: "  ",
    releaseYear: "2007",
  });

  assert.deepEqual(
    withoutArtist.find((tier) => tier.name === "album_only")?.queries,
    ["Good Girl Gone Bad"],
  );
  assert.equal(withoutAlbum.some((tier) => tier.name === "album_only"), false);
});

test("buildFlowSearchTiers appends an artist + title fallback tier after album tiers", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: [],
  });

  const last = tiers[tiers.length - 1];
  assert.equal(last?.name, "primary_track");
  assert.ok(last.queries.includes("Massive Attack Teardrop"));
  assert.ok(tiers.findIndex((tier) => tier.name === "album_track") < tiers.length - 1);
});

test("buildFlowSearchTiers fallback tier adds a version-suffix-stripped query", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Milk Inc.",
    trackName: "Never Again - Single Mix",
    albumName: "The Best Of",
    releaseYear: "2007",
    artistAliases: [],
  });

  const primary = tiers.find((tier) => tier.name === "primary_track");
  assert.ok(primary?.queries.includes("Milk Inc. Never Again - Single Mix"));
  assert.ok(primary?.queries.includes("Milk Inc. Never Again"));
  assert.ok(primary?.queries.includes("Milk Inc Never Again"));
});

test("buildFlowSearchTiers fallback tier skips queries already covered by earlier tiers", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "",
    releaseYear: "",
    artistAliases: [],
  });

  const albumTrack = tiers.find((tier) => tier.name === "album_track");
  assert.ok(albumTrack?.queries.includes("Massive Attack Teardrop"));
  const primary = tiers.find((tier) => tier.name === "primary_track");
  if (primary) {
    assert.ok(!primary.queries.includes("Massive Attack Teardrop"));
  }
});

test("selectRankedMatchAttempts spreads early attempts across users before reusing one", () => {
  const selected = selectRankedMatchAttempts(
    [
      { score: 100, raw: { user: "queuedUser", file: "A\\Album\\01 - Song.flac" } },
      { score: 99, raw: { user: "queuedUser", file: "A\\Album\\01 - Song.mp3" } },
      { score: 98, raw: { user: "altUser", file: "B\\Album\\01 - Song.flac" } },
      { score: 97, raw: { user: "thirdUser", file: "C\\Album\\01 - Song.flac" } },
    ],
    3,
  );

  assert.deepEqual(
    selected.map((entry) => entry.raw.user),
    ["queuedUser", "altUser", "thirdUser"],
  );
});

test("pipeline candidates preserve raw user/file identity for diversity selection", () => {
  const evaluations = [
    {
      candidate: { raw: { user: "first-user", file: "A\\Song.flac" } },
      decision: "accept",
      score: 1,
      reasons: [],
    },
    {
      candidate: { raw: { user: "second-user", file: "B\\Song.flac" } },
      decision: "verify",
      score: 0.5,
      reasons: [],
    },
  ];

  const pipelineCandidates = evaluations.map(toPipelineCandidate);
  assert.deepEqual(
    pipelineCandidates.map((entry) => [entry.raw.user, entry.raw.file]),
    [
      ["first-user", "A\\Song.flac"],
      ["second-user", "B\\Song.flac"],
    ],
  );
});
