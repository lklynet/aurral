import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVariants,
  compareVariantProfiles,
  checkVariantCompatibility,
  detectNoise,
  buildRequestVariantProfile,
} from "../../backend/services/trackMatching/semanticPolicy.js";

test("extractVariants detects variant descriptors without inventing them", () => {
  assert.deepEqual(
    extractVariants("Get Lucky").live && extractVariants("Get Lucky").karaoke,
    false,
  );
  const live = extractVariants("Get Lucky (Live at Wembley)");
  assert.equal(live.live, true);
  const slowed = extractVariants("Get Lucky - Slowed + Reverb");
  assert.equal(slowed.slowed, true);
  const remix = extractVariants("Get Lucky (Daft Punk Remix)");
  assert.equal(remix.remix, true);
  assert.equal(remix.mixVariant, "remix");
  const radio = extractVariants("Get Lucky (Radio Edit)");
  assert.equal(radio.mixVariant, "radio_edit");
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

test("album names never contribute candidate variant evidence", () => {
  const request = { trackName: "Get Lucky" };
  const candidate = { title: "Get Lucky", album: "Live 2017" };
  const check = checkVariantCompatibility(request, candidate);
  assert.equal(check.compatible, true);
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

test("clean/explicit hard-conflicts only when the requested rating is explicitly known", () => {
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
