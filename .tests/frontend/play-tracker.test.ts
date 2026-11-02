import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createPlayTracker } from "../../frontend/src/utils/playTracker.ts";

const listen = (
  tracker: ReturnType<typeof createPlayTracker>,
  from: number,
  to: number,
  duration: number,
) => {
  const counted: number[] = [];
  for (let time = from; time <= to; time += 0.25) {
    if (tracker.update(time, duration)) counted.push(time);
  }
  return counted;
};

test("counts a play once half the track has been heard", () => {
  const tracker = createPlayTracker();
  assert.deepEqual(listen(tracker, 0, 99.75, 200), []);
  assert.deepEqual(listen(tracker, 100, 200, 200), [100]);
});

test("counts long tracks after four minutes", () => {
  assert.deepEqual(listen(createPlayTracker(), 0, 300, 900), [240]);
});

test("never counts tracks of 30 seconds or less", () => {
  assert.deepEqual(listen(createPlayTracker(), 0, 30, 30), []);
});

test("seeking ahead does not count as listening", () => {
  const tracker = createPlayTracker();
  listen(tracker, 0, 10, 200);
  tracker.seeking();
  assert.deepEqual(listen(tracker, 190, 200, 200), []);
});
