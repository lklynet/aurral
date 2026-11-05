import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vite-plus/test";
import { filePulse, measurePulse, type TrackPulse } from "../backend/services/trackPulse.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-pulse-"));
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

function kickTrack(rate: number, seconds: number, hiss: number) {
  const samples = new Int16Array(rate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    const sinceKick = time % 0.5;
    const kick = sinceKick < 0.1 ? Math.sin(2 * Math.PI * 60 * time) * 0.8 : 0;
    const high = Math.sin(2 * Math.PI * 5000 * time) * hiss;
    samples[i] = Math.round((kick + high) * 32767);
  }
  return Buffer.from(samples.buffer);
}

function wav(pcm: Buffer, rate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function* chunks(bytes: Buffer, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

function levelsAt(pulse: TrackPulse | null, seconds: number[]) {
  assert.ok(pulse);
  const levels = Buffer.from(pulse.levels, "base64");
  return seconds.map((second) => levels[Math.round(second * pulse.fps)] ?? -1);
}

test("levels peak on each kick and drop between them, across odd chunk splits", async () => {
  const pulse = await measurePulse(chunks(kickTrack(3000, 4, 0), 333));
  const [onKick, betweenKicks] = [levelsAt(pulse, [1.02, 2.52]), levelsAt(pulse, [1.3, 2.8])];
  assert.ok(
    onKick.every((level) => level > 200),
    `kicks ${onKick}`,
  );
  assert.ok(
    betweenKicks.every((level) => level < 20),
    `gaps ${betweenKicks}`,
  );
});

test("silence has no pulse", async () => {
  assert.equal(await measurePulse(chunks(Buffer.alloc(3000 * 4 * 2), 4096)), null);
});

test("decodes a file through ffmpeg and ignores everything above the bass", async () => {
  const file = path.join(dir, "kicks.wav");
  await fs.writeFile(file, wav(kickTrack(44100, 4, 0.4), 44100));
  const pulse = await filePulse(file);
  assert.equal(pulse?.fps, 30);
  const [onKick, betweenKicks] = [levelsAt(pulse, [1.04, 2.54]), levelsAt(pulse, [1.3, 2.8])];
  assert.ok(
    onKick.every((level) => level > 200),
    `kicks ${onKick}`,
  );
  assert.ok(
    betweenKicks.every((level) => level < 40),
    `gaps ${betweenKicks}`,
  );
});

test("a file ffmpeg can't read has no pulse", async () => {
  const file = path.join(dir, "broken.flac");
  await fs.writeFile(file, "not audio");
  assert.equal(await filePulse(file), null);
});
