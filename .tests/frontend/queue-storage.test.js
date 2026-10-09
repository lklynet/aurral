import assert from "node:assert/strict";
import test from "node:test";

import { initialQueueState, queueReducer } from "../../frontend/src/utils/audioQueue.js";
import { parseStoredQueue, serializeQueue } from "../../frontend/src/utils/queueStorage.js";

const makeTracks = (count, token = "old-token") =>
  Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    title: `Track ${index}`,
    src: `/api/library/stream/t${index}?token=${token}&quality=original`,
    artwork: `/api/covers/t${index}.jpg`,
  }));

const playing = (tracks, options = {}) =>
  queueReducer(initialQueueState, {
    type: "PLAY_QUEUE",
    tracks,
    source: { type: "playlist", id: "p1", label: "Mix" },
    ...options,
  });

const restore = (state, options) => {
  const saved = parseStoredQueue(serializeQueue(state, options), options);
  return saved && queueReducer(initialQueueState, { type: "RESTORE_QUEUE", ...saved });
};

const titles = (state) => state.playbackOrder.map((index) => state.queue[index].title);

test("a reload brings back the same queue, order, and place, paused", () => {
  let state = playing(makeTracks(6), { shuffle: true });
  state = queueReducer(state, { type: "NEXT" });
  state = queueReducer(state, { type: "NEXT" });
  state = queueReducer(state, { type: "TOGGLE_REPEAT" });

  const restored = restore(state, { owner: "u1", position: 42.5, token: "old-token" });

  assert.deepEqual(titles(restored), titles(state));
  assert.equal(restored.currentIndex, 2);
  assert.equal(restored.isShuffleEnabled, true);
  assert.equal(restored.repeatMode, "all");
  assert.equal(restored.source.label, "Mix");
  assert.equal(restored.autoplay, false);
  assert.equal(parseStoredQueue(serializeQueue(state, { owner: "u1", position: 42.5 }), { owner: "u1" }).position, 42.5);

  const unshuffled = queueReducer(restored, { type: "SET_SHUFFLE", enabled: false });
  assert.deepEqual(
    unshuffled.queue.map((track) => track.title),
    makeTracks(6).map((track) => track.title),
  );
});

test("the session token never reaches storage and the current one is used after a reload", () => {
  const state = playing(makeTracks(2, "secret-token"));
  const stored = serializeQueue(state, { owner: "u1" });

  assert.equal(stored.includes("secret-token"), false);

  const restored = parseStoredQueue(stored, { owner: "u1", token: "fresh-token" });
  const src = new URL(restored.queue[0].src, "http://aurral.test");
  assert.equal(src.searchParams.get("token"), "fresh-token");
  assert.equal(src.searchParams.get("quality"), "original");
  assert.equal(restored.queue[0].artwork, "/api/covers/t0.jpg");
});

test("another user's saved queue or unreadable data is not restored", () => {
  const stored = serializeQueue(playing(makeTracks(3)), { owner: "u1" });

  assert.equal(parseStoredQueue(stored, { owner: "u2" }), null);
  assert.equal(parseStoredQueue(stored, { owner: null }), null);
  assert.equal(parseStoredQueue("{not json", { owner: "u1" }), null);
  assert.equal(
    parseStoredQueue(JSON.stringify({ ...JSON.parse(stored), version: 2 }), { owner: "u1" }),
    null,
  );
  assert.equal(
    parseStoredQueue(JSON.stringify({ ...JSON.parse(stored), playbackOrder: [0, 0, 1] }), { owner: "u1" }),
    null,
  );
  assert.equal(serializeQueue(initialQueueState, { owner: "u1" }), null);
});

test("a very long queue is saved around the current track", () => {
  let state = playing(makeTracks(1000));
  state = queueReducer(state, { type: "SKIP_TO", index: 600 });

  const stored = serializeQueue(state, { owner: "u1" });
  const restored = restore(state, { owner: "u1" });

  assert.ok(stored.length < 100_000);
  assert.ok(restored.queue.length <= 200);
  assert.equal(restored.queue[restored.playbackOrder[restored.currentIndex]].title, "Track 600");
  assert.equal(restored.queue[restored.playbackOrder[restored.currentIndex + 1]].title, "Track 601");
  assert.equal(restored.queue[restored.playbackOrder[restored.currentIndex - 1]].title, "Track 599");

  const nearEnd = queueReducer(state, { type: "SKIP_TO", index: 995 });
  const restoredNearEnd = restore(nearEnd, { owner: "u1" });
  assert.equal(titles(restoredNearEnd).at(-1), "Track 999");
  assert.equal(restoredNearEnd.queue.length, 200);
});

test("a saved queue does not replace something that is already playing", () => {
  const saved = parseStoredQueue(serializeQueue(playing(makeTracks(3)), { owner: "u1" }), { owner: "u1" });
  const current = playing([{ id: "x", title: "Now", src: "/x.mp3" }]);

  assert.equal(queueReducer(current, { type: "RESTORE_QUEUE", ...saved }), current);
});
