import assert from "node:assert/strict";
import test from "node:test";

import {
  initialQueueState,
  normalizePlaylistQueueTrack,
  normalizePreviewTrack,
  queueReducer,
  shouldRestartTrack,
} from "../../frontend/src/utils/audioQueue.js";

const track = {
  id: "flow-track",
  trackName: "Track",
  artistName: "Artist",
  streamUrl: "/stream/flow-track",
};

test("flow playback can opt out of listening history", () => {
  assert.equal(normalizePlaylistQueueTrack(track).recordHistory, true);
  assert.equal(
    normalizePlaylistQueueTrack(track, { recordHistory: false }).recordHistory,
    false,
  );
});

test("previews and playlist tracks keep their cover so the player and album-art theme can show it", () => {
  const topTrack = normalizePreviewTrack(
    { id: "1", title: "Song", preview_url: "https://p/1.mp3", artworkUrl: "https://c/top.jpg" },
    "Artist",
  );
  assert.equal(topTrack.artwork, "https://c/top.jpg");

  const releaseTrack = normalizePreviewTrack(
    { id: "2", title: "Song", preview_url: "https://p/2.mp3" },
    "Artist",
    { artwork: "https://c/release.jpg" },
  );
  assert.equal(releaseTrack.artwork, "https://c/release.jpg");

  const editorialTrack = normalizePlaylistQueueTrack({ ...track, artworkUrl: "https://c/editorial.jpg" });
  assert.equal(editorialTrack.artwork, "https://c/editorial.jpg");
});

const queueTracks = Array.from({ length: 8 }, (_, index) => ({
  id: `t${index}`,
  title: `Track ${index}`,
  src: `/stream/t${index}`,
}));

const startQueue = (options = {}) =>
  queueReducer(initialQueueState, {
    type: "PLAY_QUEUE",
    tracks: queueTracks,
    startTrackId: null,
    shuffle: false,
    source: null,
    ...options,
  });

const currentId = (state) => state.queue[state.playbackOrder[state.currentIndex]].id;
const remainingIds = (state) =>
  state.playbackOrder.slice(state.currentIndex).map((index) => state.queue[index].id);
const allIds = queueTracks.map((track) => track.id);

test("shuffle play starts with the chosen track and still plays every other track once", () => {
  for (const startTrack of queueTracks) {
    const state = startQueue({ startTrackId: startTrack.id, shuffle: true });
    assert.equal(currentId(state), startTrack.id);
    assert.deepEqual([...remainingIds(state)].sort(), allIds);
  }
});

test("shuffle play without a chosen track plays every track and varies the first one", () => {
  const firstIds = new Set();
  for (let run = 0; run < 40; run += 1) {
    const state = startQueue({ shuffle: true });
    assert.deepEqual([...remainingIds(state)].sort(), allIds);
    firstIds.add(currentId(state));
  }
  assert.ok(firstIds.size > 1);
});

test("turning shuffle on keeps the current track and queues every other track after it", () => {
  const playing = startQueue({ startTrackId: "t5" });
  const shuffled = queueReducer(playing, { type: "SET_SHUFFLE", enabled: true });
  assert.equal(currentId(shuffled), "t5");
  assert.deepEqual([...remainingIds(shuffled)].sort(), allIds);

  const unshuffled = queueReducer(shuffled, { type: "SET_SHUFFLE", enabled: false });
  assert.equal(currentId(unshuffled), "t5");
  assert.deepEqual(remainingIds(unshuffled), ["t5", "t6", "t7"]);
});

test("the end of the queue keeps the queue, shuffle, and repeat and waits paused at the start", () => {
  let state = startQueue({ startTrackId: "t6", shuffle: false });
  state = queueReducer(state, { type: "SET_SHUFFLE", enabled: true });
  for (let step = 0; step < queueTracks.length - 1; step += 1) {
    state = queueReducer(state, { type: "NEXT" });
    assert.equal(state.autoplay, true);
  }
  const lastRevision = state.queueRevision;

  const ended = queueReducer(state, { type: "NEXT" });
  assert.equal(ended.queue.length, queueTracks.length);
  assert.equal(ended.currentIndex, 0);
  assert.equal(currentId(ended), "t6");
  assert.equal(ended.autoplay, false);
  assert.equal(ended.isShuffleEnabled, true);
  assert.ok(ended.queueRevision > lastRevision);

  const repeating = queueReducer(queueReducer(state, { type: "TOGGLE_REPEAT" }), { type: "NEXT" });
  assert.equal(repeating.repeatMode, "all");
  assert.equal(repeating.currentIndex, 0);
  assert.equal(repeating.autoplay, true);
});

test("previous restarts a track after three seconds and otherwise goes back one track", () => {
  const middle = startQueue({ startTrackId: "t3" });
  assert.equal(shouldRestartTrack(middle, 12), true);
  assert.equal(shouldRestartTrack(middle, 1), false);
  assert.equal(currentId(queueReducer(middle, { type: "PREVIOUS" })), "t2");

  const first = startQueue();
  assert.equal(shouldRestartTrack(first, 1), true);
  const repeatAll = queueReducer(first, { type: "TOGGLE_REPEAT" });
  assert.equal(shouldRestartTrack(repeatAll, 1), false);
  assert.equal(currentId(queueReducer(repeatAll, { type: "PREVIOUS" })), "t7");
});

test("shuffle stays on for every queue played next and the order always matches it", () => {
  const isInOrder = (state) => state.playbackOrder.every((queueIndex, index) => queueIndex === index);
  const shuffleOn = queueReducer(startQueue(), { type: "SET_SHUFFLE", enabled: true });
  const orders = new Set();
  for (let run = 0; run < 40; run += 1) {
    const chosen = queueReducer(shuffleOn, {
      type: "PLAY_QUEUE",
      tracks: queueTracks,
      startTrackId: "t4",
      shuffle: false,
      source: null,
    });
    assert.equal(chosen.isShuffleEnabled, true);
    assert.equal(currentId(chosen), "t4");
    assert.deepEqual([...remainingIds(chosen)].sort(), allIds);
    orders.add(chosen.playbackOrder.join());

    const playAll = queueReducer(shuffleOn, {
      type: "PLAY_QUEUE",
      tracks: queueTracks,
      startTrackId: null,
      shuffle: false,
      source: null,
    });
    assert.equal(playAll.isShuffleEnabled, true);
    assert.equal(currentId(playAll), "t0");
    assert.deepEqual([...remainingIds(playAll)].sort(), allIds);
  }
  assert.ok(orders.size > 1);

  const inOrder = startQueue({ startTrackId: "t4" });
  assert.equal(inOrder.isShuffleEnabled, false);
  assert.ok(isInOrder(inOrder));

  const cleared = queueReducer(queueReducer(shuffleOn, { type: "TOGGLE_REPEAT" }), { type: "CLEAR_QUEUE" });
  assert.equal(cleared.queue.length, 0);
  assert.equal(cleared.isShuffleEnabled, true);
  assert.equal(cleared.repeatMode, "all");

  const shuffleButton = startQueue({ shuffle: true });
  assert.equal(shuffleButton.isShuffleEnabled, true);
  assert.equal(isInOrder(queueReducer(shuffleButton, { type: "SET_SHUFFLE", enabled: false })), true);
});
