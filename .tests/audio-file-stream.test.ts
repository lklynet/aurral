import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { audioContentType } from "../backend/services/audioFileStream.ts";

test("a format named like an Object method gets a generic audio type", () => {
  assert.equal(audioContentType("FLAC"), "audio/flac");
  assert.equal(audioContentType("constructor"), "audio/constructor");
  assert.equal(audioContentType("toString"), "audio/tostring");
});
