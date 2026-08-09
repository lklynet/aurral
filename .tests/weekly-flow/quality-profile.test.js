import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAudioQuality,
  createDefaultQualityProfile,
  getQualityState,
  isQualityUpgrade,
  normalizeQualityProfile,
  orderAdvertisedQualityCandidates,
} from "../../backend/services/qualityProfileModel.js";

test("classifies final audio from measured metadata at exact tier thresholds", () => {
  assert.equal(
    classifyAudioQuality(
      { format: { container: "FLAC", lossless: true, sampleRate: 48000, bitsPerSample: 16 } },
      "track.flac",
    ).tier,
    "flac-standard",
  );
  assert.equal(
    classifyAudioQuality(
      { format: { container: "FLAC", lossless: true, sampleRate: 96000, bitsPerSample: 24 } },
      "track.flac",
    ).tier,
    "flac-hires",
  );
  assert.equal(
    classifyAudioQuality(
      { format: { container: "MPEG", lossless: false, bitrate: 191500 } },
      "track.mp3",
    ).tier,
    "mp3-192",
  );
  assert.equal(
    classifyAudioQuality(
      { format: { container: "MPEG", lossless: false, bitrate: 127499 } },
      "track.mp3",
    ).tier,
    null,
  );
});

test("normalizes the one global profile and migrates the old slskd preference", () => {
  const migrated = createDefaultQualityProfile({
    preferredFormat: "mp3",
    preferredFormatStrict: true,
  });
  assert.deepEqual(migrated.enabled, ["mp3-320", "mp3-256", "mp3-192", "mp3-128"]);
  assert.equal(migrated.cutoff, "mp3-320");
  assert.equal(migrated.automaticUpgrades, false);

  const normalized = normalizeQualityProfile({
    order: ["mp3-128", "not-a-tier", "mp3-128"],
    enabled: [],
    cutoff: "not-a-tier",
    automaticUpgrades: true,
    intervalDays: 999,
  });
  assert.equal(normalized.order[0], "mp3-128");
  assert.deepEqual(normalized.enabled, ["mp3-128"]);
  assert.equal(normalized.cutoff, "mp3-128");
  assert.equal(normalized.intervalDays, 365);
});

test("uses enabled tiers and cutoff order for admission and upgrades", () => {
  const profile = normalizeQualityProfile({
    order: ["flac-standard", "mp3-320", "flac-hires", "mp3-128"],
    enabled: ["flac-standard", "mp3-320", "mp3-128"],
    cutoff: "mp3-320",
  });
  assert.equal(getQualityState({ tier: "flac-standard" }, profile), "preferred");
  assert.equal(getQualityState({ tier: "mp3-128" }, profile), "upgrade");
  assert.equal(getQualityState({ tier: "flac-hires" }, profile), "below-floor");
  assert.equal(isQualityUpgrade({ tier: "flac-standard" }, "mp3-128", profile), true);
  assert.equal(isQualityUpgrade({ tier: "mp3-320" }, "flac-hires", profile), true);
  assert.equal(isQualityUpgrade({ tier: "mp3-128" }, "mp3-320", profile), false);
});

test("prefilters advertised candidates without trusting unknown metadata", () => {
  const profile = normalizeQualityProfile({
    enabled: ["flac-standard", "mp3-320", "mp3-128"],
    cutoff: "flac-standard",
  });
  const ordered = orderAdvertisedQualityCandidates(
    ["Song 128kbps.mp3", "Song.mp3", "Song.flac", "Song 256kbps.mp3"],
    {
      profile,
      currentTier: "mp3-128",
      upgrade: true,
      readName: (entry) => entry,
    },
  );
  assert.deepEqual(ordered, ["Song.flac", "Song.mp3"]);
});
