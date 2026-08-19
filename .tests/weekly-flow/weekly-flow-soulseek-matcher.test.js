import test from "node:test";
import assert from "node:assert/strict";
import {
  bypassBannedArtistTerm,
  buildFlowSearchTiers,
  rankFlowSearchResults,
  selectRankedMatchAttempts,
  stripReleaseTypeSuffix,
  stripVersionSuffix,
  validateDownloadedTrack,
} from "../../backend/services/weeklyFlow/weeklyFlowSoulseekMatcher.js";

const rankOpts = { preferredFormat: "flac", strictFormat: false };

const result = (overrides) => ({
  size: 100,
  slots: true,
  bitrate: 900,
  speed: 700000,
  ...overrides,
});

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

test("buildFlowSearchTiers uses a short album-first plan", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });

  assert.equal(tiers[0]?.name, "base_album");
  assert.ok(
    tiers[0].queries.includes("Massive Attack Mezzanine 1998"),
  );
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
        tier.name === "album_track" &&
        tier.queries.includes("Mezzanine Teardrop"),
    ),
  );
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

test("stripVersionSuffix removes trailing version descriptors only", () => {
  assert.equal(stripVersionSuffix("Never Again - Single Mix"), "Never Again");
  assert.equal(stripVersionSuffix("Look at me now - Radio Edit"), "Look at me now");
  assert.equal(stripVersionSuffix("Flying Free - Original Mix"), "Flying Free");
  assert.equal(stripVersionSuffix("Back in Black - Live"), "Back in Black");
  assert.equal(stripVersionSuffix("Highway - Star City"), "Highway - Star City");
  assert.equal(stripVersionSuffix("Teardrop"), "Teardrop");
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

const rankFlowCases = [
  {
    name: "rankFlowSearchResults rejects same-title single matches from the wrong artist",
    results: [
      result({
        user: "wrongArtist",
        file: "Shared\\Sophia Stel\\Object Permanence {mbid:4d55c255-f2ae-4eb1-93e3-724898b132d0} {Single}\\Sophia Stel_Object Permanence_02_Object Permanence.flac",
        speed: 700000,
      }),
    ],
    track: {
      artistName: "Arm's Length",
      trackName: "Object Permanence",
      albumName: "Object Permanence - Single",
      releaseYear: "2019",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(
        ranked[0].preDownloadRejectReason,
        "weak-artist-ambiguous-title-album",
      );
    },
  },
  {
    name: "rankFlowSearchResults still accepts same-title single matches from the right artist",
    results: [
      result({
        user: "rightArtist",
        file: "Shared\\Arm's Length\\Object Permanence {Single}\\Arm's Length - Object Permanence.flac",
        speed: 700000,
      }),
    ],
    track: {
      artistName: "Arm's Length",
      trackName: "Object Permanence",
      albumName: "Object Permanence - Single",
      releaseYear: "2019",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, true);
    },
  },
  {
    name: "rankFlowSearchResults prefers folders with a strong tracklist fingerprint",
    results: [
      result({
        user: "weakUser",
        file: "Franz Ferdinand\\Misc\\01 - Take Me Out.flac",
        speed: 900000,
      }),
      result({
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\01 - Jacqueline.flac",
      }),
      result({
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\02 - Tell Her Tonight.flac",
      }),
      result({
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\03 - Take Me Out.flac",
      }),
    ],
    track: {
      artistName: "Franz Ferdinand",
      trackName: "Take Me Out",
      albumName: "Franz Ferdinand",
      releaseYear: "2004",
      artistAliases: [],
      albumTrackCount: 3,
      albumTrackTitles: ["Jacqueline", "Tell Her Tonight", "Take Me Out"],
      trackNumber: 3,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.match(ranked[0].raw.file, /03 - Take Me Out\.flac$/);
      assert.equal(ranked[0].releaseFolderFit, true);
    },
  },
  {
    name: "rankFlowSearchResults rejects older self-titled album folders for a new self-titled release",
    results: [
      result({
        user: "oldAlbumUser",
        file: "Weezer\\Weezer (1994)\\01 - My Name Is Jonas.flac",
        speed: 900000,
      }),
    ],
    track: {
      artistName: "Weezer",
      trackName: "My Name Is Jonas",
      albumName: "Weezer",
      releaseYear: "2026",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(ranked[0].preDownloadRejectReason, "self-titled-year-mismatch");
    },
  },
  {
    name: "rankFlowSearchResults prefers the fitting album folder over a higher-scoring wrong-album file",
    results: [
      result({
        user: "wrongAlbumUser",
        file: "Dashboard Confessional\\2001 The Places You Have Come to Fear the Most\\0101 - The Brilliant Dance (FLAC).flac",
        speed: 900000,
      }),
      result({
        user: "rentalsUser",
        file: "The Rentals\\Return Of The Rentals [1995]\\02 - The Rentals - Brilliant Boy.flac",
      }),
      result({
        user: "rentalsUser",
        file: "The Rentals\\Return Of The Rentals [1995]\\01 - The Rentals - Warm.flac",
      }),
    ],
    track: {
      artistName: "The Rentals",
      trackName: "Brilliant Boy",
      albumName: "Return of the Rentals",
      releaseYear: "1995",
      artistAliases: [],
      albumTrackCount: 2,
      albumTrackTitles: ["Warm", "Brilliant Boy"],
      trackNumber: 2,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.match(ranked[0].raw.file, /Brilliant Boy\.flac$/);
      assert.equal(ranked[0].releaseFolderFit, true);
      assert.match(ranked[0].raw.file, /Return Of The Rentals/);
    },
  },
  {
    name: "rankFlowSearchResults prefers album-matching directories with the target track",
    results: [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\01 - Correct Track.flac",
        speed: 900000,
      }),
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\02 - Other Song.flac",
        speed: 900000,
      }),
      result({
        user: "singleUser",
        file: "Artist Name\\Misc Folder\\Correct Track.mp3",
        bitrate: 320,
        speed: 600000,
      }),
    ],
    track: {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      releaseYear: "1999",
      artistAliases: [],
      albumTrackCount: 2,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.match(ranked[0].raw.file, /Album Name/);
      assert.equal(ranked[0].ext, ".flac");
      assert.equal(ranked[0].isLikelyMatch, true);
      assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
    },
  },
  {
    name: "rankFlowSearchResults falls back to a valid track outside the album folder when the album folder lacks it",
    results: [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\02 - Other Song.flac",
        speed: 900000,
      }),
      result({
        user: "singleUser",
        file: "Artist Name\\Misc Folder\\Correct Track.mp3",
        bitrate: 320,
        speed: 600000,
      }),
    ],
    track: {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      releaseYear: "1999",
      artistAliases: [],
      albumTrackCount: 2,
      albumTrackTitles: ["Correct Track", "Other Song"],
      trackNumber: 1,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.match(ranked[0].raw.file, /Correct Track\.mp3$/);
      assert.equal(
        ranked.some((entry) => /Other Song/.test(entry.raw.file)),
        false,
      );
    },
  },
  {
    name: "rankFlowSearchResults penalizes live variants when the requested track is plain",
    results: [
      result({
        user: "liveUser",
        file: "Artist Name\\Album Name\\01 - Correct Track (Live).flac",
        speed: 900000,
      }),
      result({
        user: "studioUser",
        file: "Artist Name\\Singles\\Correct Track.mp3",
        bitrate: 320,
        speed: 450000,
      }),
    ],
    track: {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.match(ranked[0].raw.file, /Correct Track\.mp3$/);
    },
  },
  {
    name: "rankFlowSearchResults accepts strong title and album matches without artist in path",
    results: [
      result({
        user: "albumUser",
        file: "Misc\\Demon Days\\03 - Feel Good Inc..flac",
        speed: 900000,
      }),
    ],
    track: {
      artistName: "Gorillaz",
      trackName: "Feel Good Inc.",
      albumName: "Demon Days",
      releaseYear: "2005",
      artistAliases: [],
      albumTrackCount: 15,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, true);
      assert.equal(ranked[0].isLikelyMatch, true);
    },
  },
  {
    name: "rankFlowSearchResults ignores locked slskd files for downloads",
    results: [
      result({
        user: "lockedUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        slots: false,
        locked: true,
        speed: 900000,
      }),
      result({
        user: "openUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.mp3",
        locked: false,
        bitrate: 320,
        speed: 700000,
      }),
    ],
    track: {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.some((entry) => entry.raw.user === "lockedUser"), false);
      assert.equal(ranked[0].raw.user, "openUser");
    },
  },
  {
    name: "rankFlowSearchResults skips blacklisted users and penalizes queued users",
    results: [
      result({
        user: "deadUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        speed: 900000,
      }),
      result({
        user: "queuedUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        speed: 900000,
      }),
      result({
        user: "healthyUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.mp3",
        bitrate: 320,
        speed: 700000,
      }),
    ],
    track: {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    options: {
      isUserBlacklisted: (user) => user === "deadUser",
      getUserQueuePenalty: (user) => (user === "queuedUser" ? 200 : 0),
    },
    assertRanked(ranked) {
      assert.equal(ranked.some((entry) => entry.raw.user === "deadUser"), false);
      assert.equal(ranked[0].raw.user, "healthyUser");
    },
  },
  {
    name: "rankFlowSearchResults accepts soulseek backslash paths for albums with live in the title",
    results: [
      {
        user: "deveng",
        file: "music\\From Autumn To Ashes\\The Fiction We Live\\01 The After Dinner Payback.flac",
        slots: 1,
        speed: 7440000,
      },
      {
        user: "PassOnTheTorch",
        file: "music\\From Autumn to Ashes\\The Fiction We Live\\01 The After Dinner Payback.flac",
        slots: 1,
        speed: 6000000,
      },
    ],
    track: {
      artistName: "From Autumn to Ashes",
      trackName: "The After Dinner Payback",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 1,
      albumTrackCount: 12,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, true);
      assert.equal(ranked[0].preDownloadRejectReason, null);
      assert.match(ranked[0].raw.file, /After Dinner Payback\.flac$/);
    },
  },
  {
    name: "rankFlowSearchResults reads the artist from the filename when the folder hides it",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Marlow Vance - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 100);
      assert.equal(ranked[0].preDownloadValid, true);
    },
  },
  {
    name: "rankFlowSearchResults still rejects a filename naming a different artist",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Priya Raman - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(ranked[0].preDownloadRejectReason, "weak-artist-match");
    },
  },
  {
    name: "rankFlowSearchResults does not credit an artist segment that only shares a word",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Marlow Sinclair - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(ranked[0].preDownloadRejectReason, "weak-artist-match");
    },
  },
  {
    name: "rankFlowSearchResults keeps a numeric artist name without a leading track number",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Club Hits\\50 Cent - In Da Club.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "50 Cent",
      trackName: "In Da Club",
      albumName: "Album Name",
      releaseYear: "2003",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 100);
      assert.equal(ranked[0].preDownloadValid, true);
    },
  },
  {
    name: "rankFlowSearchResults keeps an artist name that starts with digits",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Club Hits\\07. 50 Cent - In Da Club.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "50 Cent",
      trackName: "In Da Club",
      albumName: "Album Name",
      releaseYear: "2003",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 100);
      assert.equal(ranked[0].preDownloadValid, true);
    },
  },
  {
    name: "rankFlowSearchResults only credits the leading filename segment as the artist",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Hits\\Other Artist - Marlow Vance - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(ranked[0].preDownloadRejectReason, "weak-artist-match");
    },
  },
  {
    name: "rankFlowSearchResults does not read an artist from a title - artist filename",
    results: [
      result({
        user: "ripUser",
        file: "Various\\Rips\\Wide Awake Tonight - Marlow Vance.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].preDownloadValid, false);
    },
  },
  {
    name: "rankFlowSearchResults rejects a filename naming a different artist even in an album-matching folder",
    results: [
      result({
        user: "albumUser",
        file: "Some Person\\Album Name (2004)\\05. Other Artist - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].breakdown.albumScore >= 35, true);
      assert.equal(ranked[0].preDownloadValid, false);
      assert.equal(ranked[0].preDownloadRejectReason, "weak-artist-match");
    },
  },
  {
    name: "rankFlowSearchResults keeps the folder artist score when the filename names someone else",
    results: [
      result({
        user: "albumUser",
        file: "Marlow Vance\\Album Name (2004)\\03 - Guest Person - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 100);
      assert.equal(ranked[0].preDownloadValid, true);
    },
  },
  {
    name: "rankFlowSearchResults does not read an artist from a filename without the artist - title shape",
    results: [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track: {
      artistName: "Marlow Vance",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      artistAliases: [],
    },
    assertRanked(ranked) {
      assert.equal(ranked.length, 1);
      assert.equal(ranked[0].breakdown.artistScore, 0);
      assert.equal(ranked[0].preDownloadValid, false);
    },
  },
  {
    name: "rankFlowSearchResults does not treat live as a variant in ordinary title words",
    results: [
      {
        user: "albumUser",
        file: "Artist\\The Fiction We Live\\03 - The Fiction We Live.flac",
        slots: 1,
        speed: 700000,
      },
    ],
    track: {
      artistName: "From Autumn to Ashes",
      trackName: "The Fiction We Live",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 3,
    },
    assertRanked(ranked) {
      assert.ok(ranked.length > 0);
      assert.equal(ranked[0].preDownloadValid, true);
      assert.equal(ranked[0].breakdown.variantHardMismatch, false);
    },
  },
];

for (const { name, results, track, options, assertRanked } of rankFlowCases) {
  test(name, () => {
    const ranked = rankFlowSearchResults(results, track, {
      ...rankOpts,
      ...options,
    });
    assertRanked(ranked);
  });
}

test("rankFlowSearchResults preserves M4A as the preferred format", () => {
  const ranked = rankFlowSearchResults(
    [
      result({ user: "sameUser", file: "Artist\\Album\\01 - Song.flac" }),
      result({ user: "sameUser", file: "Artist\\Album\\01 - Song.m4a" }),
    ],
    { artistName: "Artist", trackName: "Song", albumName: "Album", trackNumber: 1 },
    { preferredFormat: "m4a", strictFormat: false },
  );

  assert.equal(ranked[0]?.ext, ".m4a");
});

test("selectRankedMatchAttempts spreads early attempts across users before reusing one", () => {
  const selected = selectRankedMatchAttempts(
    [
      {
        score: 100,
        raw: { user: "queuedUser", file: "A\\Album\\01 - Song.flac" },
      },
      {
        score: 99,
        raw: { user: "queuedUser", file: "A\\Album\\01 - Song.mp3" },
      },
      {
        score: 98,
        raw: { user: "altUser", file: "B\\Album\\01 - Song.flac" },
      },
      {
        score: 97,
        raw: { user: "thirdUser", file: "C\\Album\\01 - Song.flac" },
      },
    ],
    3,
  );

  assert.deepEqual(
    selected.map((entry) => entry.raw.user),
    ["queuedUser", "altUser", "thirdUser"],
  );
});

test("validateDownloadedTrack scores identity before final quality admission", async () => {
  const rejected = await validateDownloadedTrack(
    "/tmp/does-not-exist.mp3",
    {
      raw: {
        file: "Artist Name\\Album Name\\01 - Correct Track (Live).mp3",
      },
    },
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
    },
  );
  assert.equal(rejected.valid, false);
  assert.equal(rejected.scores.trackNumberMismatch, false);
  assert.ok(rejected.scores.variant < 0);

  const accepted = await validateDownloadedTrack(
    "/tmp/does-not-exist.flac",
    {
      preDownloadValid: true,
      raw: {
        file: "Of Mice & Men\\Of Mice & Men\\03 - Second & Sebring.flac",
      },
    },
    {
      artistName: "Of Mice & Men",
      trackName: "Second & Sebring",
      albumName: "Of Mice & Men",
      trackNumber: 3,
      durationMs: 433000,
    },
  );
  assert.equal(accepted.valid, false);
  assert.match(accepted.reason, /^quality-unknown:/);
  assert.notEqual(accepted.scores.matchReason, "pre-download-trusted");
  assert.equal(accepted.scores.preDownloadValid, true);
  assert.ok(accepted.scores.title >= 82);
});

test("validateDownloadedTrack scores path segments without weak-word inflation", async () => {
  const good = await validateDownloadedTrack(
    "/tmp/does-not-exist.mp3",
    { raw: { file: "Ryan Montbleau\\Stages_ Volume III\\02 Ghosts.mp3" } },
    {
      artistName: "Ryan Montbleau",
      trackName: "Ghosts",
      albumName: "Stages: Volume III",
      durationMs: 207000,
    },
  );
  assert.equal(good.scores.artist, 100);
  assert.equal(good.scores.title, 100);
  assert.equal(good.scores.album, 100);

  const weak = await validateDownloadedTrack(
    "/tmp/does-not-exist.mp3",
    { raw: { file: "The\\Random Dump\\01 Something Else.mp3" } },
    {
      artistName: "The Weeknd",
      trackName: "Something Else",
      albumName: "Random Dump",
      durationMs: 200000,
    },
  );
  assert.ok(weak.scores.artist < 92);
});

test("rankFlowSearchResults accepts a candidate whose advertised duration matches", () => {
  const ranked = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 224 })],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
    rankOpts,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.equal(ranked[0].preDownloadRejectReason, null);
  assert.equal(ranked[0].breakdown.advertisedDurationMs, 224000);
});

test("rankFlowSearchResults rejects a strong title match whose advertised duration is off", () => {
  const ranked = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 340 })],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
    rankOpts,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, false);
  assert.equal(ranked[0].preDownloadRejectReason, "advertised-duration-mismatch");
});

test("rankFlowSearchResults ignores duration when the file advertises none", () => {
  const ranked = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3" })],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
    rankOpts,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.equal(ranked[0].breakdown.advertisedDurationMs, null);
});

test("rankFlowSearchResults ignores advertised duration when the track has none expected", () => {
  const ranked = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 340 })],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
    },
    rankOpts,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, true);
});

test("rankFlowSearchResults keeps advertised duration within the 18 percent window", () => {
  const ranked = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 199 })],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
    rankOpts,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, true);
});

test("rankFlowSearchResults keeps the correct-duration file over a longer off-duration copy in the same folder", () => {
  const ranked = rankFlowSearchResults(
    [
      result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.flac", length: 420, speed: 9000000 }),
      result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 226, speed: 700000 }),
    ],
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
    rankOpts,
  );
  // With albumName set, ranking returns one best candidate per folder. Without the
  // gate the longer .flac wins (preferred format, faster peer) even though it is the
  // wrong duration; the gate rejects it, so the correct .mp3 is chosen instead.
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.match(ranked[0].raw.file, /\/Teardrop\.mp3$/);
  assert.equal(ranked[0].breakdown.advertisedDurationMs, 226000);
});

test("rankFlowSearchResults anchors the base tolerance boundary at 25 seconds", () => {
  const track = { artistName: "Massive Attack", trackName: "Teardrop", albumName: "Mezzanine", durationMs: 100000 };
  const atEdge = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 75 })],
    track,
    rankOpts,
  );
  assert.equal(atEdge[0].preDownloadValid, true);
  const pastEdge = rankFlowSearchResults(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 74 })],
    track,
    rankOpts,
  );
  assert.equal(pastEdge[0].preDownloadValid, false);
  assert.equal(pastEdge[0].preDownloadRejectReason, "advertised-duration-mismatch");
});

test("validateDownloadedTrack does not gate on the advertised length after download", async () => {
  const checked = await validateDownloadedTrack(
    "/tmp/does-not-exist.mp3",
    { raw: { file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 9999 } },
    {
      artistName: "Massive Attack",
      trackName: "Teardrop",
      albumName: "Mezzanine",
      durationMs: 226000,
    },
  );
  assert.notEqual(checked.scores.matchReason, "advertised-duration-mismatch");
  assert.equal(checked.scores.matchReason, null);
});
