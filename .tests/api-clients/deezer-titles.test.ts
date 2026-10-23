import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeTitle } from "../../backend/services/apiClients/deezer.ts";

test("normalizeTitle drops edition labels", () => {
  assert.equal(normalizeTitle("Album (Deluxe Edition) [Explicit]"), "album");
  assert.equal(normalizeTitle("Song - 2011 Remaster"), "song");
  assert.equal(normalizeTitle("Song (Part 2)"), "song part 2");
});

test("normalizeTitle stays fast on long adversarial titles", { timeout: 1_000 }, () => {
  assert.equal(normalizeTitle(`x${" ".repeat(100_000)}y`), "x y");
  assert.equal(normalizeTitle("(live".repeat(20_000)), Array(20_000).fill("live").join(" "));
});
