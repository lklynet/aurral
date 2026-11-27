import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { IAudioMetadata } from "music-metadata";
import { buildActualFileCandidate } from "../../backend/services/trackMatching/postDownloadValidator.ts";

test("the disc number comes from the file's disk tag", () => {
  const parsed = {
    common: { title: "Song", discNumber: 2, discTotal: 3, trackNumber: 4, trackTotal: 10 },
    format: {},
  } as IAudioMetadata;
  const candidate = buildActualFileCandidate(parsed, "/music/Song.flac", "soulseek");
  assert.equal(candidate.discNumber, 2);
  assert.equal(candidate.trackNumber, 4);
});
