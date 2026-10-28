import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { findBeats } from "../../backend/services/wrapped/beats.ts";

const RATE = 22050;

function clickTrack(bpm: number, accent: number) {
  const samples = new Float32Array(RATE * 30);
  const clicks = Array.from(
    { length: Math.floor((30 - 1) / (60 / bpm)) },
    (_, i) => 0.8 + (i * 60) / bpm,
  );
  let noise = 1;
  clicks.forEach((time, index) => {
    const from = Math.round(time * RATE);
    for (let i = 0; i < RATE * 0.06; i++) {
      const decay = Math.exp(-i / (RATE * 0.01));
      noise = (noise * 1103515245 + 12345) % 2147483648;
      samples[from + i] += (noise / 1073741824 - 1) * 0.3 * decay;
      if (index % 4 === accent)
        samples[from + i] += Math.sin((2 * Math.PI * 60 * i) / RATE) * 0.8 * decay;
    }
  });
  return { samples, clicks };
}

test("finds the tempo, beats, and downbeats of a steady click track", () => {
  const { samples, clicks } = clickTrack(120, 2);
  const found = findBeats(samples);
  assert.ok(found);
  assert.ok(Math.abs(found.bpm - 120) < 1, `bpm ${found.bpm}`);
  for (const beat of found.beats) {
    const step = (beat - clicks[0]) / 0.5;
    assert.ok(Math.abs(step - Math.round(step)) * 0.5 < 0.03, `${beat} is off the beat`);
  }
  const downbeat = found.beats[found.downbeat];
  const accented = clicks.filter((_, index) => index % 4 === 2);
  assert.ok(
    accented.some((click) => Math.abs(click - downbeat) < 0.03),
    `downbeat ${downbeat}`,
  );
});

test("finds no beats in silence", () => {
  assert.equal(findBeats(new Float32Array(RATE * 30)), null);
});
