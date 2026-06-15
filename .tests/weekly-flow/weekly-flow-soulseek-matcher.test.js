import test from "node:test";
import assert from "node:assert/strict";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const [
  {
    bypassBannedArtistTerm,
    buildFlowSearchQueries,
    buildFlowSearchTiers,
    buildFlowAlbumSearchQueries,
    buildFlowArtistOnlySearchQueries,
    buildFlowTrackFallbackSearchQueries,
    buildFlowWildcardAlbumSearchQueries,
    buildFlowWildcardTrackFallbackSearchQueries,
    buildHalfAlbumTitle,
    buildTrimmedBypassText,
    buildVolumeVariationTexts,
    removeSearchAccents,
    rankFlowSearchResults,
    selectRankedMatchAttempts,
    validateDownloadedTrack,
  },
] = await Promise.all([
  importFromRepo("backend/services/weeklyFlowSoulseekMatcher.js"),
]);

test("bypassBannedArtistTerm replaces the first artist character with a wildcard", () => {
  assert.equal(bypassBannedArtistTerm("Franz Ferdinand"), "*ranz Ferdinand");
  assert.equal(bypassBannedArtistTerm("*ranz Ferdinand"), "*ranz Ferdinand");
  assert.equal(bypassBannedArtistTerm("A"), "A");
  assert.equal(bypassBannedArtistTerm(""), "");
});

test("buildFlowWildcardAlbumSearchQueries uses wildcard artist terms", () => {
  const queries = buildFlowWildcardAlbumSearchQueries({
    artistName: "Franz Ferdinand",
    trackName: "Take Me Out",
    albumName: "Franz Ferdinand",
    releaseYear: "2004",
    artistAliases: [],
  });

  assert.ok(queries.includes("*ranz Ferdinand Franz Ferdinand"));
  assert.ok(queries.includes("*ranz Ferdinand Franz Ferdinand 2004"));
  assert.ok(!queries.includes("Franz Ferdinand Franz Ferdinand"));
});

test("buildFlowArtistOnlySearchQueries returns wildcard artist-only searches", () => {
  const queries = buildFlowArtistOnlySearchQueries({
    artistName: "Franz Ferdinand",
    trackName: "Take Me Out",
    albumName: "Franz Ferdinand",
    artistAliases: ["Franz F."],
  });

  assert.deepEqual(queries, ["*ranz Ferdinand", "*ranz F."]);
});

test("buildFlowWildcardTrackFallbackSearchQueries wildcard-prefixes artist track searches", () => {
  const queries = buildFlowWildcardTrackFallbackSearchQueries({
    artistName: "Franz Ferdinand",
    trackName: "Take Me Out",
    albumName: "Franz Ferdinand",
    artistAliases: [],
  });

  assert.ok(queries.includes("*ranz Ferdinand Take Me Out"));
  assert.ok(queries.includes("Take Me Out Franz Ferdinand"));
});

test("buildFlowAlbumSearchQueries keeps album-only searches separate from track fallbacks", () => {
  const albumQueries = buildFlowAlbumSearchQueries({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });
  const fallbackQueries = buildFlowTrackFallbackSearchQueries({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });

  assert.deepEqual(albumQueries.slice(0, 2), [
    "Massive Attack Mezzanine",
    "Massive Attack Mezzanine 1998",
  ]);
  assert.ok(albumQueries.includes("Massive Attk Mezzanine"));
  assert.ok(!albumQueries.includes("Massive Attack Teardrop"));
  assert.ok(fallbackQueries.includes("Massive Attack Teardrop"));
  assert.ok(fallbackQueries.includes("Massive Attk Teardrop"));
});

test("buildFlowSearchTiers starts with track search before album fallbacks", () => {
  const tiers = buildFlowSearchTiers({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });

  assert.equal(tiers[0]?.name, "primary_track");
  assert.ok(tiers[0].queries.includes("Massive Attack Teardrop"));
  assert.ok(
    tiers.some(
      (tier) =>
        tier.name === "base_album" &&
        tier.queries.includes("Massive Attack Mezzanine 1998"),
    ),
  );
  assert.ok(
    tiers.some(
      (tier) =>
        tier.name === "track_fallback" &&
        tier.queries.includes("Massive Attk Teardrop"),
    ),
  );
});

test("buildFlowSearchQueries includes track-first and album fallback searches", () => {
  const queries = buildFlowSearchQueries({
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    releaseYear: "1998",
    artistAliases: ["Massive Attk"],
  });

  assert.ok(queries[0].includes("Massive Attack Teardrop"));
  assert.ok(queries.includes("Massive Attack Mezzanine 1998"));
  assert.ok(queries.includes("Massive Attk Teardrop"));
});

test("search variation helpers normalize and trim bypass text", () => {
  assert.equal(removeSearchAccents("Björk"), "Bjork");
  assert.equal(buildTrimmedBypassText("Bob Dylan"), "Bob Dyla");
  assert.equal(
    buildVolumeVariationTexts("Artist Album Vol. 2")[0],
    "Artist Album Vol. 2",
  );
  assert.ok(
    buildVolumeVariationTexts("Artist Album Vol. 2").includes(
      "Artist Album Volume 2",
    ),
  );
  assert.equal(
    buildHalfAlbumTitle("The Fiction We Live On Forever"),
    "The Fiction We",
  );
});

test("buildFlowSearchQueries adds artist-free track plus album fallbacks", () => {
  const queries = buildFlowSearchQueries({
    artistName: "Gorillaz",
    trackName: "Feel Good Inc.",
    albumName: "Demon Days",
    releaseYear: "2005",
    artistAliases: [],
  });

  assert.ok(queries.includes("Feel Good Inc. Demon Days"));
  assert.ok(queries.includes("Feel Good Inc. Demon Days 2005"));
  assert.ok(queries.includes("Gorillaz Demon Days"));
  assert.ok(queries.includes("Gorillaz Feel Good Inc."));
});

test("buildFlowSearchQueries adds simplified variants for parenthetical and slash-heavy titles", () => {
  const queries = buildFlowSearchQueries({
    artistName: "Bully",
    trackName: "Lose You (feat. Soccer Mommy)",
    albumName: "Lucky For You",
    artistAliases: [],
  });

  assert.ok(queries.includes("Bully Lose You (feat. Soccer Mommy)"));
  assert.ok(queries.includes("Bully Lose You"));

  const slashQueries = buildFlowSearchQueries({
    artistName: "LOVING",
    trackName: "A long slow little wave / citizen, an activity",
    albumName: "Any Light",
    artistAliases: [],
  });

  assert.ok(
    slashQueries.includes(
      "LOVING A long slow little wave / citizen, an activity",
    ),
  );
  assert.ok(slashQueries.includes("LOVING A long slow little wave"));
  assert.ok(
    slashQueries.some(
      (query) =>
        query.includes("citizen") && query.includes("activity") && query.startsWith("LOVING"),
    ),
  );
});

test("rankFlowSearchResults prefers folders with a strong tracklist fingerprint", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "weakUser",
        file: "Franz Ferdinand\\Misc\\01 - Take Me Out.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\01 - Jacqueline.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 700000,
      },
      {
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\02 - Tell Her Tonight.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 700000,
      },
      {
        user: "albumUser",
        file: "Franz Ferdinand\\Franz Ferdinand (2004)\\03 - Take Me Out.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 700000,
      },
    ],
    {
      artistName: "Franz Ferdinand",
      trackName: "Take Me Out",
      albumName: "Franz Ferdinand",
      releaseYear: "2004",
      artistAliases: [],
      albumTrackCount: 3,
      albumTrackTitles: ["Jacqueline", "Tell Her Tonight", "Take Me Out"],
      trackNumber: 3,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.match(ranked[0].raw.file, /03 - Take Me Out\.flac$/);
  assert.equal(ranked[0].releaseFolderFit, true);
});

test("rankFlowSearchResults prefers the fitting album folder over a higher-scoring wrong-album file", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "wrongAlbumUser",
        file: "Dashboard Confessional\\2001 The Places You Have Come to Fear the Most\\0101 - The Brilliant Dance (FLAC).flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "rentalsUser",
        file: "The Rentals\\Return Of The Rentals [1995]\\02 - The Rentals - Brilliant Boy.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 700000,
      },
      {
        user: "rentalsUser",
        file: "The Rentals\\Return Of The Rentals [1995]\\01 - The Rentals - Warm.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 700000,
      },
    ],
    {
      artistName: "The Rentals",
      trackName: "Brilliant Boy",
      albumName: "Return of the Rentals",
      releaseYear: "1995",
      artistAliases: [],
      albumTrackCount: 2,
      albumTrackTitles: ["Warm", "Brilliant Boy"],
      trackNumber: 2,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.match(ranked[0].raw.file, /Brilliant Boy\.flac$/);
  assert.equal(ranked[0].releaseFolderFit, true);
  assert.match(ranked[0].raw.file, /Return Of The Rentals/);
});

test("rankFlowSearchResults prefers album-matching directories with the target track", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\01 - Correct Track.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\02 - Other Song.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "singleUser",
        file: "Artist Name\\Misc Folder\\Correct Track.mp3",
        size: 100,
        slots: true,
        bitrate: 320,
        speed: 600000,
      },
    ],
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      releaseYear: "1999",
      artistAliases: [],
      albumTrackCount: 2,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.match(ranked[0].raw.file, /Album Name/);
  assert.equal(ranked[0].ext, ".flac");
  assert.equal(ranked[0].isLikelyMatch, true);
  assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
});

test("rankFlowSearchResults falls back to a valid track outside the album folder when the album folder lacks it", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "albumUser",
        file: "Artist Name\\Album Name (1999)\\02 - Other Song.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "singleUser",
        file: "Artist Name\\Misc Folder\\Correct Track.mp3",
        size: 100,
        slots: true,
        bitrate: 320,
        speed: 600000,
      },
    ],
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      releaseYear: "1999",
      artistAliases: [],
      albumTrackCount: 2,
      albumTrackTitles: ["Correct Track", "Other Song"],
      trackNumber: 1,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.match(ranked[0].raw.file, /Correct Track\.mp3$/);
  assert.equal(
    ranked.some((entry) => /Other Song/.test(entry.raw.file)),
    false,
  );
});

test("rankFlowSearchResults penalizes live variants when the requested track is plain", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "liveUser",
        file: "Artist Name\\Album Name\\01 - Correct Track (Live).flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "studioUser",
        file: "Artist Name\\Singles\\Correct Track.mp3",
        size: 100,
        slots: true,
        bitrate: 320,
        speed: 450000,
      },
    ],
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.match(ranked[0].raw.file, /Correct Track\.mp3$/);
});

test("rankFlowSearchResults accepts strong title and album matches without artist in path", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "albumUser",
        file: "Misc\\Demon Days\\03 - Feel Good Inc..flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
    ],
    {
      artistName: "Gorillaz",
      trackName: "Feel Good Inc.",
      albumName: "Demon Days",
      releaseYear: "2005",
      artistAliases: [],
      albumTrackCount: 15,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.equal(ranked[0].isLikelyMatch, true);
});

test("rankFlowSearchResults ignores locked slskd files for downloads", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "lockedUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        size: 100,
        slots: false,
        locked: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "openUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.mp3",
        size: 100,
        slots: true,
        locked: false,
        bitrate: 320,
        speed: 700000,
      },
    ],
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.equal(ranked.some((entry) => entry.raw.user === "lockedUser"), false);
  assert.equal(ranked[0].raw.user, "openUser");
});

test("rankFlowSearchResults skips blacklisted users and penalizes queued users", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "deadUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "queuedUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.flac",
        size: 100,
        slots: true,
        bitrate: 900,
        speed: 900000,
      },
      {
        user: "healthyUser",
        file: "Artist Name\\Album Name\\01 - Correct Track.mp3",
        size: 100,
        slots: true,
        bitrate: 320,
        speed: 700000,
      },
    ],
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
      isUserBlacklisted: (user) => user === "deadUser",
      getUserQueuePenalty: (user) => (user === "queuedUser" ? 200 : 0),
    },
  );

  assert.equal(ranked.some((entry) => entry.raw.user === "deadUser"), false);
  assert.equal(ranked[0].raw.user, "healthyUser");
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

test("validateDownloadedTrack rejects obvious live mismatches from the remote filename", async () => {
  const validation = await validateDownloadedTrack(
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

  assert.equal(validation.valid, false);
  assert.equal(validation.scores.trackNumberMismatch, false);
  assert.ok(validation.scores.variant < 0);
});

test("validateDownloadedTrack accepts candidates that pass pre-download thresholds", async () => {
  const validation = await validateDownloadedTrack(
    "/tmp/does-not-exist.flac",
    {
      raw: {
        file: "Of Mice & Men\\Of Mice & Men\\03 - Second & Sebring.flac",
      },
    },
    {
      artistName: "Of Mice & Men",
      trackName: "Second & Sebring",
      albumName: "Of Mice & Men",
      trackNumber: 3,
    },
  );

  assert.equal(validation.valid, true);
  assert.ok(validation.scores.title >= 82);
});

test("validateDownloadedTrack still scores preDownloadValid candidates", async () => {
  const validation = await validateDownloadedTrack(
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

  assert.equal(validation.valid, true);
  assert.notEqual(validation.scores.matchReason, "pre-download-trusted");
  assert.equal(validation.scores.preDownloadValid, true);
  assert.ok(validation.scores.title >= 82);
});

test("rankFlowSearchResults accepts soulseek backslash paths for albums with live in the title", () => {
  const ranked = rankFlowSearchResults(
    [
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
    {
      artistName: "From Autumn to Ashes",
      trackName: "The After Dinner Payback",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 1,
      albumTrackCount: 12,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.equal(ranked[0].preDownloadRejectReason, null);
  assert.match(ranked[0].raw.file, /After Dinner Payback\.flac$/);
});

test("rankFlowSearchResults does not treat live as a variant in ordinary title words", () => {
  const ranked = rankFlowSearchResults(
    [
      {
        user: "albumUser",
        file: "Artist\\The Fiction We Live\\03 - The Fiction We Live.flac",
        slots: 1,
        speed: 700000,
      },
    ],
    {
      artistName: "From Autumn to Ashes",
      trackName: "The Fiction We Live",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 3,
    },
    {
      preferredFormat: "flac",
      strictFormat: false,
    },
  );

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].preDownloadValid, true);
  assert.equal(ranked[0].breakdown.variantHardMismatch, false);
});
