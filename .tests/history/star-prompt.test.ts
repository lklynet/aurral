import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, playEvents, starPrompt] = await setupIsolatedBackend(
  "star-prompt",
  () => import("../../backend/services/playEventService.ts"),
  () => import("../../backend/services/starPrompt.ts"),
);
const { db } = await import("../../backend/config/db-sqlite.ts");

const play = (userId: number, index: number) =>
  playEvents.recordPlayEvent(userId, {
    trackId: `song:${index}`,
    title: `Song ${index}`,
    artist: "Artist",
    source: "native-player",
  });

beforeEach(() => {
  resetDatabase(db);
  const insert = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
  insert.run("listener", "test");
  insert.run("other", "test");
});

afterAll(async () => cleanupIsolatedState(isolatedState));

test("shows the star prompt once a user reaches 50 plays, and only once", () => {
  for (let index = 0; index < 49; index++) play(1, index);
  assert.equal(starPrompt.claimStarPrompt(1), false);

  play(1, 49);
  assert.equal(starPrompt.claimStarPrompt(1), true);
  assert.equal(starPrompt.claimStarPrompt(1), false);

  for (let index = 0; index < 50; index++) play(2, index);
  assert.equal(starPrompt.claimStarPrompt(2), true);
});
