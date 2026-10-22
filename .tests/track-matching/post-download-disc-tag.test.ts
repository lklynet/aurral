import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { IAudioMetadata } from "music-metadata";
import { buildActualFileCandidate } from "../../backend/services/trackMatching/postDownloadValidator.ts";

test("the disc number comes from the file's disk tag", () => {
  const parsed = {
    common: { title: "Song", disk: { no: 2, of: 3 }, track: { no: 4, of: 10 } },
    format: {},
  } as IAudioMetadata;
  const candidate = buildActualFileCandidate(parsed, "/music/Song.flac", "soulseek");
  assert.equal(candidate.discNumber, 2);
  assert.equal(candidate.trackNumber, 4);
});
