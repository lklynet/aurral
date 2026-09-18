// Regression corpus for the Soulseek adapter through the unified matching
// pipeline. Each case is a historical behavior from the old per-source
// matcher, re-expressed as: raw slskd results → buildSourceCandidates →
// decisions. Identity correctness gates the candidate list; quality profile
// preference only orders candidates that already passed identity.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceCandidates,
  hasUsableSearchCandidates,
  isBeetsMatcherAvailable,
  resetMatcherAvailability,
  usableEvaluationEntries,
} from "../../backend/services/trackMatching/index.js";

resetMatcherAvailability();
const beetsAvailable = await isBeetsMatcherAvailable();
const skip = beetsAvailable ? false : "beets not installed for any available Python interpreter";
const btest = (name, fn) => test(name, { skip }, fn);
import { orderAdvertisedQualityCandidates, getAdvertisedQualityRank } from "../../backend/services/qualityProfileModel.js";
import { getQualityProfile } from "../../backend/services/qualityProfileService.js";

const result = (overrides) => ({
  size: 100,
  slots: true,
  bitrate: 900,
  speed: 700000,
  ...overrides,
});

const flacProfile = { order: ["flac-hires", "flac-standard", "mp3-320"], enabled: ["flac-hires", "flac-standard", "mp3-320"], cutoff: "flac-standard" };

async function evaluate(results, track, options = {}) {
  return buildSourceCandidates({
    source: "soulseek",
    results,
    request: track,
    options: { qualityProfile: flacProfile, ...options },
  });
}

function usableFileNames(evaluation) {
  return usableEvaluationEntries(evaluation).map(
    (entry) => entry.candidate.raw.file,
  );
}

btest("same-title single from the wrong artist is not offered as a candidate", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "wrongArtist",
        file: "Shared\\Sophia Stel\\Object Permanence {mbid:4d55c255-f2ae-4eb1-93e3-724898b132d0} {Single}\\Sophia Stel_Object Permanence_02_Object Permanence.flac",
        speed: 700000,
      }),
    ],
    {
      artistName: "Arm's Length",
      trackName: "Object Permanence",
      albumName: "Object Permanence - Single",
      releaseYear: "2019",
      artistAliases: [],
    },
  );
  assert.deepEqual(usableFileNames(evaluation), []);
});

btest("same-title single from the right artist is offered", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "rightArtist",
        file: "Shared\\Arm's Length\\Object Permanence {Single}\\Arm's Length - Object Permanence.flac",
        speed: 700000,
      }),
    ],
    {
      artistName: "Arm's Length",
      trackName: "Object Permanence",
      albumName: "Object Permanence - Single",
      releaseYear: "2019",
      artistAliases: [],
    },
  );
  assert.equal(usableFileNames(evaluation).length, 1);
  assert.match(usableFileNames(evaluation)[0], /Object Permanence\.flac$/);
});

btest("folder with a matching tracklist fingerprint wins over a same-title file in a misc folder", async () => {
  const evaluation = await evaluate(
    [
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
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.ok(usable.length > 0);
  // The misc-folder sibling ("01 - Take Me Out" parsed with no artist) must
  // not beat the release folder whose tracklist matches the request.
  assert.match(usable[0].candidate.raw.file, /03 - Take Me Out\.flac$/);
  assert.ok(usable[0].distance <= usable[usable.length - 1].distance);
});

btest("self-titled folder with a conflicting year is downgraded from accept to verify", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "oldAlbumUser",
        file: "Weezer\\Weezer (1994)\\01 - My Name Is Jonas.flac",
        speed: 900000,
      }),
    ],
    {
      artistName: "Weezer",
      trackName: "My Name Is Jonas",
      albumName: "Weezer",
      releaseYear: "2026",
      artistAliases: [],
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].decision, "verify");
  assert.equal(usable[0].aurralEvidence.year.conflicting, true);
});

btest("a fitting album folder beats a same-title file from a wrong-artist album", async () => {
  const evaluation = await evaluate(
    [
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
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.ok(usable.length > 0);
  assert.match(usable[0].candidate.raw.file, /Brilliant Boy\.flac$/);
  assert.match(usable[0].candidate.raw.file, /Return Of The Rentals/);
});

btest("falls back to a valid track outside the album folder when the album folder lacks it", async () => {
  const evaluation = await evaluate(
    [
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
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.ok(usable.length > 0);
  assert.match(usable[0].candidate.raw.file, /Correct Track\.mp3$/);
  assert.equal(usable.some((entry) => /Other Song/.test(entry.candidate.raw.file)), false);
});

btest("live variant is rejected by contradiction when the requested track is plain", async () => {
  const evaluation = await evaluate(
    [
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
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
  );
  assert.match(usableFileNames(evaluation)[0], /Correct Track\.mp3$/);
  const live = evaluation.evaluations.find((entry) => /Live/.test(entry.candidate.raw.file));
  assert.equal(live.decision, "reject");
  assert.ok(live.contradictions.includes("live"));
});

btest("strong title and album match is usable without the artist anywhere in the path", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Misc\\Demon Days\\03 - Feel Good Inc..flac",
        speed: 900000,
      }),
    ],
    {
      artistName: "Gorillaz",
      trackName: "Feel Good Inc.",
      albumName: "Demon Days",
      releaseYear: "2005",
      artistAliases: [],
      albumTrackCount: 15,
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  // Nobody in the path names Gorillaz: the candidate survives as a
  // last-resort verify, never as a straight accept.
  assert.equal(usable.length, 1);
  assert.equal(usable[0].decision, "verify");
  assert.equal(usable[0].reasons.some((reason) => reason.includes("requested artist")), true);
});

btest("locked slskd files are ignored", async () => {
  const evaluation = await evaluate(
    [
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
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
  );
  const users = usableEvaluationEntries(evaluation).map(
    (entry) => entry.candidate.raw.user,
  );
  assert.equal(users.includes("lockedUser"), false);
  assert.equal(evaluation.evaluations.length, 1);
});

btest("blacklisted users are excluded; queued users only lose ordering, not eligibility", async () => {
  const evaluation = await evaluate(
    [
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
    {
      artistName: "Artist Name",
      trackName: "Correct Track",
      albumName: "Album Name",
      artistAliases: [],
    },
    {
      isUserBlacklisted: (user) => user === "deadUser",
      getUserQueuePenalty: (user) => (user === "queuedUser" ? 200 : 0),
    },
  );
  const users = usableEvaluationEntries(evaluation).map(
    (entry) => entry.candidate.raw.user,
  );
  assert.equal(users.includes("deadUser"), false);
  assert.ok(users.includes("healthyUser"));
  assert.ok(users.includes("queuedUser"));
});

btest("soulseek backslash paths for albums are usable", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "deveng",
        file: "music\\From Autumn To Ashes\\The Fiction We Live\\01 The After Dinner Payback.flac",
        slots: 1,
        speed: 7440000,
      }),
    ],
    {
      artistName: "From Autumn to Ashes",
      trackName: "The After Dinner Payback",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 1,
      albumTrackCount: 12,
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.ok(usable.length > 0);
  assert.match(usable[0].candidate.raw.file, /After Dinner Payback\.flac$/);
});

btest("requested mix variant accepts an undeclared file and rejects a different mix", async () => {
  const track = {
    artistName: "Artist Name",
    trackName: "Wide Awake Tonight - Radio Edit",
    albumName: "Album Name",
    releaseYear: "2004",
    trackNumber: 11,
    albumTrackCount: 13,
    durationMs: 226000,
    artistAliases: [],
  };
  const undeclared = await evaluate(
    [
      result({
        user: "silentUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    track,
  );
  assert.equal(usableFileNames(undeclared).length, 1);

  const declared = await evaluate(
    [
      result({
        user: "labelledUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight (Radio Edit).mp3",
        bitrate: 320,
      }),
    ],
    track,
  );
  assert.equal(usableFileNames(declared).length, 1);

  const extended = await evaluate(
    [
      result({
        user: "extendedUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight (Extended Mix).mp3",
        bitrate: 320,
      }),
    ],
    track,
  );
  assert.deepEqual(usableFileNames(extended), []);
  const rejected = extended.evaluations[0];
  assert.equal(rejected.decision, "reject");
  assert.ok(rejected.contradictions.includes("extended"));
});

btest("plain request rejects candidates declaring a mix variant", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "extendedUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight (Extended Mix).mp3",
        bitrate: 320,
      }),
    ],
    {
      artistName: "Artist Name",
      trackName: "Wide Awake Tonight",
      albumName: "Album Name",
      releaseYear: "2004",
      trackNumber: 11,
      albumTrackCount: 13,
      artistAliases: [],
    },
  );
  assert.deepEqual(usableFileNames(evaluation), []);
});

btest("a declared requested variant ranks above an undeclared copy", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "silentUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
      result({
        user: "labelledUser",
        file: "Artist Name\\Album Name (2004)\\11 - Wide Awake Tonight (Radio Edit).mp3",
        bitrate: 320,
      }),
    ],
    {
      artistName: "Artist Name",
      trackName: "Wide Awake Tonight - Radio Edit",
      albumName: "Album Name",
      releaseYear: "2004",
      trackNumber: 11,
      albumTrackCount: 13,
      durationMs: 226000,
      artistAliases: [],
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 2);
  assert.equal(usable[0].candidate.raw.user, "labelledUser");
});

btest("filename artist parsing: exact, shared-word, and numeric artists", async () => {
  const exact = await evaluate(
    [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Marlow Vance - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  assert.equal(usableFileNames(exact).length, 1);

  const otherArtist = await evaluate(
    [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Priya Raman - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  assert.deepEqual(usableFileNames(otherArtist), []);

  const sharedWord = await evaluate(
    [
      result({
        user: "compilationUser",
        file: "Various\\Top 100 Hits of 2004\\82. Marlow Sinclair - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  assert.deepEqual(usableFileNames(sharedWord), []);

  const numeric = await evaluate(
    [
      result({
        user: "compilationUser",
        file: "Various\\Club Hits\\07. 50 Cent - In Da Club.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "50 Cent", trackName: "In Da Club", albumName: "Album Name", releaseYear: "2003", artistAliases: [] },
  );
  assert.equal(usableFileNames(numeric).length, 1);
});

btest("title - artist filenames do not credit the trailing segment as the artist", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "ripUser",
        file: "Various\\Rips\\Wide Awake Tonight - Marlow Vance.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  assert.deepEqual(usableFileNames(evaluation), []);
});

btest("a filename naming a different artist is rejected even in an album-matching folder", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Some Person\\Album Name (2004)\\05. Other Artist - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  assert.deepEqual(usableFileNames(evaluation), []);
});

btest("the folder artist score survives a guest-artist filename", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Marlow Vance\\Album Name (2004)\\03 - Guest Person - Wide Awake Tonight.mp3",
        bitrate: 320,
      }),
    ],
    { artistName: "Marlow Vance", trackName: "Wide Awake Tonight", albumName: "Album Name", releaseYear: "2004", artistAliases: [] },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].decision, "accept");
});

btest("'live' inside ordinary title words is not a variant", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Artist\\The Fiction We Live\\03 - The Fiction We Live.flac",
        slots: 1,
        speed: 700000,
      }),
    ],
    {
      artistName: "From Autumn to Ashes",
      trackName: "The Fiction We Live",
      albumName: "The Fiction We Live",
      releaseYear: "2003",
      trackNumber: 3,
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 1);
  assert.equal((usable[0].contradictions ?? []).length, 0);
});

btest("quality profile orders identity-passing candidates without excluding the folder file", async () => {
  const folder = "Shared\\El Canto Del Loco\\Por Mi y por Todos Mis Companeros (2009)";
  const track = {
    artistName: "El Canto Del Loco",
    trackName: "Aunque Tu No Lo Sepas",
    albumName: "Por Mi y por Todos Mis Companeros",
    releaseYear: "2009",
    artistAliases: [],
  };
  const results = [
    result({
      user: "peer",
      file: `${folder}\\04 - El Canto Del Loco - Aunque Tu No Lo Sepas.flac`,
      bitrate: null,
      size: 30000000,
    }),
    result({
      user: "peer",
      file: `${folder}\\04 - El Canto Del Loco - Aunque Tu No Lo Sepas.mp3`,
      bitrate: 320,
      size: 9000000,
    }),
  ];
  const evaluation = await evaluate(results, track);
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 2);
  const mp3Profile = { order: ["mp3-320", "flac-standard"], enabled: ["mp3-320"], cutoff: "mp3-320" };
  const ordered = orderAdvertisedQualityCandidates(usable, {
    profile: mp3Profile,
    readName: (entry) => entry.candidate?.raw?.file,
    readBitrate: (entry) => entry.candidate?.raw?.bitrate,
  });
  assert.ok(ordered[0].candidate.raw.file.endsWith(".mp3"));
});

btest("single-file folders outside the fitting set stay reachable when identity is strong", async () => {
  const album = "Por Mi y por Todos Mis Companeros";
  const titles = [
    "Aunque Tu No Lo Sepas",
    "Zapatillas",
    "La Madre de Jose",
    "Puede Ser",
    "Peter Pan",
    "Besos",
    "Volveras",
    "Son Suenos",
    "El Chico",
    "Contigo",
    "Insoportable",
    "A Ti",
  ];
  const track = {
    artistName: "El Canto Del Loco",
    trackName: "Aunque Tu No Lo Sepas",
    albumName: album,
    releaseYear: "2009",
    artistAliases: [],
    albumTrackCount: 12,
    albumTrackTitles: titles,
    trackNumber: 1,
  };
  const albumFolder = titles.map((title, index) =>
    result({
      user: "albumPeer",
      file: `Peer1\\El Canto Del Loco\\${album} (2009)\\${String(index + 1).padStart(2, "0")} - ${title}.mp3`,
      bitrate: 320,
      size: 9000000,
    }),
  );
  const loose = [
    result({
      user: "loosePeerA",
      file: `PeerA\\${album}\\01 - Aunque Tu No Lo Sepas.mp3`,
      bitrate: 320,
      size: 9100000,
    }),
    result({
      user: "loosePeerB",
      file: `PeerB\\${album}\\Aunque Tu No Lo Sepas.mp3`,
      bitrate: 320,
      size: 9200000,
    }),
  ];
  const evaluation = await evaluate([...albumFolder, ...loose], track);
  const usable = usableEvaluationEntries(evaluation);
  const users = [...new Set(usable.map((entry) => entry.candidate.raw.user))];
  assert.ok(users.includes("albumPeer"));
  assert.ok(users.includes("loosePeerA"));
  assert.ok(users.includes("loosePeerB"));
  assert.equal(usable[0].candidate.raw.user, "albumPeer");
});

btest("sibling-track conflict rejects a same-title different-track candidate", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (2019)\\02 - Hole In The Sheet.mp3",
        bitrate: 320,
      }),
    ],
    {
      artistName: "Artist Name",
      trackName: "Hole In The Sheet",
      albumName: "Album Name",
      releaseYear: "2019",
      artistAliases: [],
      albumTrackTitles: ["Hole In The Sheet", "Hole In My Sheet"],
      trackNumber: 1,
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  // The wrong-position file costs index confidence: verify, not accept.
  assert.equal(usable.length, 1);
  assert.equal(usable[0].decision, "verify");
  assert.equal(usable[0].penalties.track_index > 0, true);
});

btest("wrong track number with imperfect metadata is rejected; exact identity rescues it", async () => {
  const track = {
    artistName: "Artist Name",
    trackName: "Track Number Three",
    albumName: "Album Name",
    releaseYear: "2019",
    trackNumber: 2,
    artistAliases: [],
  };
  const wrongSong = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (2019)\\03 - A Different Song Entirely.mp3",
        bitrate: 320,
      }),
    ],
    track,
  );
  assert.deepEqual(usableFileNames(wrongSong), []);

  // The old matcher's rule, preserved: a near-exact title rescue is allowed
  // (the file is probably the right recording at the wrong position).
  const exactTitle = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (2019)\\03 - Track Number Three.mp3",
        bitrate: 320,
      }),
    ],
    track,
  );
  assert.equal(usableFileNames(exactTitle).length, 1);
});

btest("track number parsed from the filename satisfies the expected position", async () => {
  const evaluation = await evaluate(
    [
      result({
        user: "albumUser",
        file: "Artist Name\\Album Name (2019)\\02 - Second Song.mp3",
        bitrate: 320,
      }),
    ],
    {
      artistName: "Artist Name",
      trackName: "Second Song",
      albumName: "Album Name",
      releaseYear: "2019",
      trackNumber: 2,
      artistAliases: [],
    },
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].aurralEvidence.trackNumber.mismatch, false);
});

btest("advertised duration: near matches are usable, far matches are not offered", async () => {
  const track = {
    artistName: "Massive Attack",
    trackName: "Teardrop",
    albumName: "Mezzanine",
    durationMs: 226000,
  };
  const near = await evaluate(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 224 })],
    track,
  );
  assert.equal(usableFileNames(near).length, 1);

  const far = await evaluate(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 340 })],
    track,
  );
  assert.deepEqual(usableFileNames(far), []);

  const noAdvertised = await evaluate(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3" })],
    track,
  );
  assert.equal(usableFileNames(noAdvertised).length, 1);

  const noExpected = await evaluate(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 340 })],
    { artistName: "Massive Attack", trackName: "Teardrop", albumName: "Mezzanine" },
  );
  assert.equal(usableFileNames(noExpected).length, 1);

  const withinWindow = await evaluate(
    [result({ user: "peer", file: "Massive Attack/Mezzanine/Teardrop.mp3", length: 199 })],
    track,
  );
  assert.equal(usableFileNames(withinWindow).length, 1);
});

btest("the correct-duration file wins over a longer off-duration copy in the same folder", async () => {
  const evaluation = await evaluate(
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
  );
  const usable = usableEvaluationEntries(evaluation);
  assert.equal(usable.length, 1);
  assert.match(usable[0].candidate.raw.file, /\/Teardrop\.mp3$/);
});

btest("quality ordering within identity: profile-eligible tier wins", async () => {
  const entries = [
    { candidate: { raw: { file: "Song.flac", bitrate: 900 } } },
    { candidate: { raw: { file: "Song.m4a", bitrate: 320 } } },
  ];
  const m4aProfile = {
    order: ["m4a-320", "flac-standard"],
    enabled: ["m4a-320", "flac-standard"],
    cutoff: "m4a-320",
  };
  const ordered = orderAdvertisedQualityCandidates(entries, {
    profile: m4aProfile,
    readName: (entry) => entry.candidate.raw.file,
    readBitrate: (entry) => entry.candidate.raw.bitrate,
  });
  assert.ok(ordered[0].candidate.raw.file.endsWith(".m4a"));
});
