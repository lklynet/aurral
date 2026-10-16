import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVariants,
  compareVariantProfiles,
  checkVariantCompatibility,
  detectNoise,
} from "../../backend/services/trackMatching/semanticPolicy.js";
import { decideRecording, verifyDownloadedRecording } from "../../backend/services/trackMatching/nativeMatcher.js";

test("extractVariants detects variant descriptors without inventing them", () => {
  const plain = extractVariants("Get Lucky");
  assert.equal(plain.live, false);
  assert.equal(plain.karaoke, false);
  const live = extractVariants("Get Lucky (Live at Wembley)");
  assert.equal(live.live, true);
  assert.equal(extractVariants("The Rock Show (live in Chicago)").live, true);
  assert.equal(extractVariants("Nirvana - Breed (Live And Loud, Seattle / 1993)").live, true);
  assert.equal(extractVariants("Breed [Live, 1991]").live, true);
  assert.equal(extractVariants("Breed (Lives of Others Mix)").live, false);
  const slowed = extractVariants("Get Lucky - Slowed + Reverb");
  assert.equal(slowed.slowed, true);
  const remix = extractVariants("Get Lucky (Daft Punk Remix)");
  assert.equal(remix.remix, true);
  assert.equal(remix.mixVariant, "remix");
  assert.equal(extractVariants("Get Lucky (Mash-Up)").remix, true);
  assert.equal(extractVariants("Get Lucky (Mash Up)").remix, true);
  assert.equal(extractVariants("Get Lucky (Mashup)").remix, true);
  const radio = extractVariants("Get Lucky (Radio Edit)");
  assert.equal(radio.mixVariant, "radio_edit");
  assert.equal(extractVariants("Get Lucky (Original Mix)").mixVariant, null);
  assert.equal(extractVariants("Get Lucky (Album Mix)").mixVariant, null);
  const karaoke = extractVariants("Get Lucky Karaoke Version");
  assert.equal(karaoke.karaoke, true);
});

test("extractVariants does not fire on words inside real titles", () => {
  // "Live and Let Die" is a real title, not a live recording.
  assert.equal(extractVariants("Live and Let Die").live, false);
  // "Demon Days" contains "demo" as a substring, not a descriptor.
  assert.equal(extractVariants("Demon Days").demo, false);
});

test("cover detection ignores embedded 'disco(ver)' substrings", () => {
  assert.equal(extractVariants("Disco Inferno").cover, false);
  assert.equal(extractVariants("Get Lucky (Cover by Someone)").cover, true);
});

test("variant contradictions are hard rejections", () => {
  const expected = extractVariants("Get Lucky");
  const karaoke = extractVariants("Get Lucky (Karaoke Version)");
  const karaokeCheck = compareVariantProfiles(expected, karaoke);
  assert.equal(karaokeCheck.contradictions.includes("karaoke"), true);
  assert.equal(karaokeCheck.contradictions.length > 0, true);

  const liveCheck = compareVariantProfiles(expected, extractVariants("Get Lucky (Live)"));
  assert.equal(liveCheck.contradictions.includes("live"), true);

  const unplugged = checkVariantCompatibility({ trackName: "Get Lucky" }, { title: "Get Lucky (MTV Unplugged)" });
  assert.ok(unplugged.contradictions.includes("acoustic"));
});

test("matching variants reinforce instead of contradicting", () => {
  const expected = extractVariants("Get Lucky (Live at Wembley)");
  const actual = extractVariants("Get Lucky (Live)");
  const check = compareVariantProfiles(expected, actual);
  assert.equal(check.contradictions.length, 0);
  assert.ok(check.score > 0);
});

test("different mix variants contradict each other", () => {
  const expected = extractVariants("Get Lucky (Radio Edit)");
  const actual = extractVariants("Get Lucky (Extended Mix)");
  const check = compareVariantProfiles(expected, actual);
  assert.equal(check.contradictions.includes("extended"), true);
});

const getLucky = { trackName: "Get Lucky", artistName: "Daft Punk", albumName: "Random Access Memories" };

test("an offered artist, album, or release folder that names an unrequested version contradicts", () => {
  const cases = [
    [{ album: "Random Access Memories (Acoustic)" }, "acoustic"],
    [{ album: "Live 2017" }, "live"],
    [{ artists: ["Karaoke Kings"] }, "karaoke"],
    [{ path: "Music/Daft Punk/Random Access Memories (Remixes)/08 Get Lucky.flac" }, "remix"],
    [{ path: "Daft Punk/2014 Live In Paris/08 Get Lucky.flac" }, "live"],
    [{ path: "Daft Punk/Random Access Memories/CD 2 - Live/08 Get Lucky.flac" }, "live"],
    [{ directoryPath: "Daft Punk/Random Access Memories [Unplugged]", filename: "08 Get Lucky.flac" }, "acoustic"],
    [{ path: "Daft Punk/Random Access Memories (Instrumentals)/08 Get Lucky.flac" }, "instrumental"],
    [{ path: "karaoke home made/Daft Punk/Random Access Memories/08 Get Lucky.mp3" }, "karaoke"],
    [{ album: "Random Access Memories (Covers Album)" }, "cover"],
    [{ path: "Daft Punk/A Tribute to Random Access Memories/08 Get Lucky.flac" }, "cover"],
    [{ path: "Daft Punk/Random Access Memories (Reissue + Live In London Bonus Disc)/CD 1/08 Get Lucky.flac" }, "live"],
    [{ path: "Daft_Punk-Random_Access_Memories_Instrumentals-WEB-2013/08-get_lucky.flac" }, "instrumental"],
    [{ album: "Random.Access.Memories.Live.2013" }, "live"],
  ];
  for (const [offered, variant] of cases) {
    const check = checkVariantCompatibility(getLucky, { title: "Get Lucky", ...offered });
    assert.equal(check.compatible, false, JSON.stringify(offered));
    assert.ok(check.contradictions.includes(variant), JSON.stringify(offered));
  }
});

test("names and share folders that contain version words stay compatible", () => {
  const compatible = (request, candidate) => checkVariantCompatibility(request, candidate).compatible;
  for (const [request, candidate] of [
    [getLucky, { title: "Get Lucky", path: "Music/Live/Daft Punk/Random Access Memories/08 Get Lucky.flac" }],
    [getLucky, { title: "Get Lucky", path: "Compilations & Live Albums/Random Access Memories/08 Get Lucky.flac" }],
    [getLucky, { title: "Get Lucky", path: "Daft Punk/(2013) Random Access Memories [Run for Cover Records] [FLAC]/08 Get Lucky.flac" }],
    [getLucky, { title: "Get Lucky", path: "Daft Punk/Random Access Memories [FLAC+Covers]/08 Get Lucky.flac" }],
    [getLucky, { title: "Get Lucky", album: "Random Access Memories (with covers)" }],
    [{ trackName: "Live and Let Die", artistName: "Wings" }, { title: "Wings - Live and Let Die" }],
    [{ trackName: "Breed", artistName: "Nirvana", albumName: "Live And Loud" },
      { title: "Nirvana - Breed (Live And Loud, Seattle / 1993)" }],
    [{ trackName: "Unplugged", artistName: "Snot", albumName: "Get Some" },
      { title: "unplugged", path: "collection/snot/1997-get_some/11-unplugged.flac" }],
    [{ trackName: "Violet", artistName: "Hole", albumName: "Live Through This" },
      { title: "Violet", album: "Live Through This", path: "Hole/Hole - Live Through This/Hole - Live Through This - 03 - Violet.flac" }],
    [{ trackName: "Selling the Drama", artistName: "Live", albumName: "Throwing Copper" },
      { title: "Selling the Drama", artists: ["Live"], path: "Music/Live/Live - Throwing Copper/02 Selling the Drama.flac" }],
    [{ trackName: "The Audience", artistName: "The Chariot", albumName: "Long Live" },
      { title: "The Audience", album: "Long Live", path: "The Chariot/2010 - Long Live/01 The Audience.flac" }],
    [{ trackName: "Sounds Good", artistName: "Acoustic Alchemy", albumName: "Red Dust & Spanish Lace" },
      { title: "Sounds Good", artists: ["Acoustic Alchemy"], path: "Acoustic Alchemy/Red Dust & Spanish Lace/01 Sounds Good.flac" }],
    [{ trackName: "Song", artistName: "Band", albumName: "Live - The Album" },
      { title: "Song", path: "Band/Band - Live - The Album (2001) [FLAC]/01 Song.flac" }],
  ]) assert.equal(compatible(request, candidate), true, JSON.stringify(candidate));
  for (const path of [
    "Live/Live - Live at the Paradiso/05 Selling the Drama.flac",
    "Live/Live at the Paradiso/05 Selling the Drama.flac",
    "Live/2008 - Live at the Paradiso/05 Selling the Drama.flac",
    "The Damned/CD 03 - Live At The 100 Club 1977/05 Selling the Drama.flac",
  ]) {
    for (const artistName of ["Live", "Lïve"]) {
      assert.equal(compatible({ trackName: "Selling the Drama", artistName, albumName: "Throwing Copper" },
        { title: "Selling the Drama", path }), false, `${artistName}: ${path}`);
    }
  }
  for (const path of [
    "Lïve/Lïve - Throwing Copper/02 Selling the Drama.flac",
    "Live (US alt rock band)/1994 - Throwing Copper/02 Selling the Drama.flac",
    "Live/Live - 1994 - Throwing Copper/02 Selling the Drama.flac",
    "Albums/[1994] Live - Throwing Copper/02 Selling the Drama.flac",
    "Live_-_Throwing_Copper/02 Selling the Drama.flac",
  ]) {
    assert.equal(compatible({ trackName: "Selling the Drama", artistName: "Lïve", albumName: "Throwing Copper" },
      { title: "Selling the Drama", path }), true, path);
  }
});

test("a version the request names in its track, album, or artist is allowed in the offered names", () => {
  const check = (request, candidate) => checkVariantCompatibility(request, candidate);
  assert.equal(check(
    { trackName: "Apology (Acoustic)", artistName: "Band", albumName: "Album" },
    { title: "Apology (Acoustic)", path: "Band/Album (Acoustic)/15 Apology (Acoustic).flac" },
  ).compatible, true);
  const liveAlbum = { trackName: "Song", artistName: "Band", albumName: "Live at Wembley" };
  assert.equal(check(liveAlbum, { title: "Song (Live)", path: "Band/2015 - Live at Wembley/03 Song (Live).flac" }).compatible, true);
  assert.deepEqual(check(liveAlbum, { title: "Song (Acoustic)" }).contradictions, ["acoustic"]);
  assert.equal(check(
    { trackName: "Robot Rock", artistName: "Daft Punk", albumName: "Human After All (Remixes)" },
    { title: "Robot Rock (Soulwax Remix)", path: "Daft Punk/Human After All - Remixes/01 Robot Rock (Soulwax Remix).flac" },
  ).compatible, true);
  const alive = { trackName: "Deuce", artistName: "KISS", albumName: "Alive!", secondaryTypes: ["Live"] };
  assert.equal(check(alive, { title: "Deuce (Live)", path: "KISS/Alive! (Live 1975)/01 Deuce (Live).flac" }).compatible, true);
  assert.deepEqual(check(alive, { title: "Deuce (Acoustic)" }).contradictions, ["acoustic"]);
  assert.deepEqual(check({ ...alive, secondaryTypes: [] }, { title: "Deuce (Live)" }).contradictions, ["live"]);
  const karaoke = { trackName: "Song", artistName: "Karaoke Kings", albumName: "Hits" };
  assert.equal(check(karaoke, { title: "Song (Karaoke Version)" }).compatible, true);
  const alchemy = { trackName: "Sounds Good", artistName: "Acoustic Alchemy", albumName: "Red Dust & Spanish Lace" };
  assert.deepEqual(check(alchemy, { title: "Sounds Good (Acoustic)" }).contradictions, ["acoustic"]);
  const liveSingle = { trackName: "Song (Live)", artistName: "Band", albumName: "Song (Live)" };
  assert.equal(check(liveSingle, { title: "Song (Live)", path: "Band/Band - Song (Live)/01 Song (Live).flac" }).compatible, true);
  assert.deepEqual(check(liveSingle, { title: "Song" }).contradictions, ["live"]);
  assert.equal(check(
    { trackName: "Kiss Me", artistName: "Band", albumName: "Live the Dream" },
    { title: "Kiss Me", album: "Live the Dream", path: "Band/Live the Dream/01 Kiss Me.flac" },
  ).compatible, true);
});

test("a version only another track of the release names is not requested", () => {
  const studio = { trackName: "Song", artistName: "Band", albumName: "Studio Album",
    albumTrackTitles: ["Song", "Other", "Other (Live at Wembley)", "Song (Remix)"] };
  const live = checkVariantCompatibility(studio, { title: "Song", filename: "05 - Song.flac", album: "Live in Paris",
    path: "Music/Band/Band - Live in Paris (2004)/05 - Song.flac", artists: ["Band"] });
  assert.deepEqual(live.contradictions, ["live"]);
  const remixes = checkVariantCompatibility({ ...studio, trackName: "Song (Remix)" },
    { title: "Song (Remix)", path: "Band/Studio Album (Live)/04 Song (Remix).flac" });
  assert.deepEqual(remixes.contradictions, ["live"]);
  assert.equal(checkVariantCompatibility({ ...studio, trackName: "Song (Remix)" },
    { title: "Song (Remix)", path: "Band/Studio Album (Remixes)/04 Song (Remix).flac" }).compatible, true);
});

test("request-level variant hints participate in the comparison", () => {
  const request = { trackName: "Get Lucky", variants: { karaoke: false } };
  const candidate = { title: "Get Lucky (Karaoke Version)" };
  const check = checkVariantCompatibility(request, candidate);
  assert.equal(check.compatible, false);
});

test("detectNoise flags downloader junk", () => {
  assert.deepEqual(detectNoise("Get Lucky 10 hour loop"), ["loop"]);
  assert.deepEqual(detectNoise("Get Lucky (Reaction)"), ["reaction"]);
  assert.deepEqual(detectNoise("Get Lucky official audio"), []);
});

test("clean/explicit conflicts with a known rating, and a censored copy with an unrated request", () => {
  // Requested a clean version, offered explicit: hard contradiction.
  const cleanRequest = { trackName: "Song (Clean Version)" };
  const explicitCandidate = { title: "Song (Explicit)" };
  const cleanCheck = checkVariantCompatibility(cleanRequest, explicitCandidate);
  assert.equal(cleanCheck.compatible, false);
  assert.ok(cleanCheck.contradictions.includes("content-rating-explicit"));

  // Unqualified request: an explicit candidate is soft evidence, never a
  // contradiction.
  const plainRequest = { trackName: "Song" };
  const softCheck = checkVariantCompatibility(plainRequest, explicitCandidate);
  assert.equal(softCheck.compatible, true);

  // Unqualified request: a clean or edited copy is censored audio.
  for (const title of ["Song (Clean Version)", "Song (Album Version (Edited))"]) {
    const censored = checkVariantCompatibility(plainRequest, { title });
    assert.ok(censored.contradictions.includes("content-rating-clean"), title);
  }

  // Requested explicit, offered clean: also a hard contradiction.
  const explicitRequest = { trackName: "Song (Explicit)" };
  const cleanCandidate = { title: "Song (Clean Version)" };
  const explicitCheck = checkVariantCompatibility(explicitRequest, cleanCandidate);
  assert.equal(explicitCheck.compatible, false);
  assert.ok(explicitCheck.contradictions.includes("content-rating-clean"));
});

test("re-recordings contradict; ordinary remasters do not", () => {
  const plainRequest = { trackName: "Song" };
  // A re-recording is a different performance of the work.
  const rerecorded = checkVariantCompatibility(plainRequest, {
    title: "Song (2020 Rerecorded Version)",
  });
  assert.equal(rerecorded.compatible, false);
  assert.ok(rerecorded.contradictions.includes("cover"));

  const rerecorded2 = checkVariantCompatibility(plainRequest, {
    title: "Song (Re-Recorded)",
  });
  assert.equal(rerecorded2.compatible, false);

  // A remaster of the same recording stays compatible.
  const remaster = checkVariantCompatibility(plainRequest, {
    title: "Song (2011 Remaster)",
  });
  assert.equal(remaster.compatible, true);
  assert.equal(remaster.contradictions.length, 0);
});

test("an unrequested stereo or alternate mix contradicts unless a requested name names it, and mono only against stereo", () => {
  const heyJude = { trackName: "Hey Jude", artistName: "The Beatles", albumName: "1" };
  const contradictions = (request, title) => checkVariantCompatibility(request, { title }).contradictions;
  assert.deepEqual(contradictions(heyJude, "Hey Jude (2015 Stereo Mix)"), ["alternate_mix"]);
  assert.deepEqual(contradictions(heyJude, "Hey Jude (Alternate Mix)"), ["alternate_mix"]);
  assert.deepEqual(contradictions(heyJude, "Hey Jude - Alternative Version"), ["alternate_mix"]);
  assert.deepEqual(contradictions(heyJude, "Hey Jude (Remastered 2015)"), []);
  assert.deepEqual(contradictions(heyJude, "Hey Jude (2009 Stereo Remaster)"), []);
  assert.deepEqual(contradictions(heyJude, "Hey Jude (Mono)"), []);
  assert.deepEqual(contradictions({ ...heyJude, trackName: "Hey Jude (Mono)" }, "Hey Jude (Stereo)"), ["stereo"]);
  assert.deepEqual(contradictions({ ...heyJude, trackName: "Hey Jude (Alternate Mix)" }, "Hey Jude (Alternate Mix)"), []);
  for (const [request, title] of [
    [{ artistName: "The Beach Boys", albumName: "Pet Sounds (Stereo Mix)", trackName: "Wouldn't It Be Nice" },
      "Wouldn't It Be Nice (Stereo Mix)"],
    [{ artistName: "The Beach Boys", albumName: "SMiLE (soniclovenoize 1967 stereo mix)", trackName: "Heroes and Villains" },
      "Heroes and Villains (1967 stereo mix)"],
    [{ artistName: "The Beatles", albumName: "Sessions (Alternate Takes)", trackName: "Strawberry Fields Forever" },
      "Strawberry Fields Forever (Alternate Take)"],
  ]) {
    assert.deepEqual(contradictions(request, title), [], title);
    assert.deepEqual(contradictions({ ...request, albumName: "Greatest Hits" }, title), ["alternate_mix"], title);
  }
});

test("native pre-download and post-download paths reject the same variant conflict", () => {
  const request = { title: "Get Lucky", artists: ["Daft Punk"], durationMs: 248000 };
  const candidate = { title: "Get Lucky (Karaoke Version)", artists: ["Daft Punk"], durationMs: 248000 };
  const preDownload = decideRecording(request, [candidate]);
  const postDownload = verifyDownloadedRecording(request, candidate);
  assert.equal(preDownload.decision, "skip");
  assert.equal(postDownload.decision, "no_match");
  assert.ok(preDownload.candidates[0].contradictions.includes("karaoke"));
  assert.ok(postDownload.contradictions.includes("karaoke"));
});
