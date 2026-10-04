import test from "node:test";
import assert from "node:assert/strict";
import {
  bypassBannedArtistTerm,
  buildAlbumSearchTiers,
  buildTrackSearchTiers,
  buildTrackQueryVariants,
  selectRankedMatchAttempts,
  stripReleaseTypeSuffix,
  stripVersionSuffix,
} from "../../backend/services/downloadJobs/trackSearchQueries.js";
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

test("buildTrackSearchTiers uses a short album-first plan", () => {
  const tiers = buildTrackSearchTiers({
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

test("buildTrackSearchTiers searches the album title alone only after every artist query", () => {
  const queries = buildTrackSearchTiers({
    artistName: "Rihanna",
    trackName: "Umbrella",
    albumName: "Good Girl Gone Bad",
    releaseYear: "2007",
  }).flatMap((tier) => tier.queries);

  assert.equal(queries.at(-1), "Good Girl Gone Bad");
  assert.ok(queries.indexOf("Rihanna Good Girl Gone Bad") < queries.indexOf("Rihanna Umbrella"));
  assert.ok(queries.indexOf("Rihanna Umbrella") < queries.indexOf("*ihanna Good Girl Gone Bad"));
  assert.ok(queries.indexOf("Good Girl Gone Bad Umbrella") < queries.indexOf("Good Girl Gone Bad"));
});

test("buildTrackSearchTiers adds album-only search without an artist and skips blank albums", () => {
  const withoutArtist = buildTrackSearchTiers({
    artistName: "",
    trackName: "Umbrella",
    albumName: "Good Girl Gone Bad",
    releaseYear: "2007",
  });
  const withoutAlbum = buildTrackSearchTiers({
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

test("buildTrackSearchTiers tries the artist and title right after the artist and album", () => {
  const tiers = buildTrackSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: [],
  });

  assert.equal(tiers[0]?.name, "base_album");
  assert.equal(tiers[1]?.name, "primary_track");
  assert.ok(tiers[1].queries.includes("Massive Attack Teardrop"));
});

test("buildTrackSearchTiers fallback tier adds a version-suffix-stripped query", () => {
  const tiers = buildTrackSearchTiers({
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

test("buildTrackSearchTiers asks each query once", () => {
  const queries = buildTrackSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "",
    releaseYear: "",
    artistAliases: [],
  }).flatMap((tier) => tier.queries);

  assert.ok(queries.includes("Massive Attack Teardrop"));
  assert.equal(new Set(queries.map((query) => query.toLowerCase())).size, queries.length);
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

test("an album grab searches for the album and never for a track title", () => {
  const queries = buildAlbumSearchTiers({
    artistName: "Radiohead",
    trackName: "Paranoid Android",
    albumName: "OK Computer",
    releaseYear: "1997",
  }).flatMap((tier) => tier.queries);
  assert.ok(queries.length > 0);
  assert.ok(queries.every((query) => query.includes("OK Computer")));
  assert.ok(queries.every((query) => !query.includes("Paranoid Android")));
});
