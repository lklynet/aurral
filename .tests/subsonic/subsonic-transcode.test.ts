import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vite-plus/test";
import { flacCopy } from "../../backend/services/flacCache.ts";
import { streamSubsonicAudio } from "../../backend/services/subsonicTranscodeService.ts";
import { createMockHttpServer } from "../helpers/backendTestHarness.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-transcode-"));

afterAll(() => fs.rm(dir, { recursive: true, force: true }));

async function alacFile(name: string) {
  const filePath = path.join(dir, name);
  await promisify(execFile)("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "alac", filePath],
  ]);
  return filePath;
}

test("an Opus file under the bitrate limit streams as is", async () => {
  const filePath = path.join(dir, "track.opus");
  await promisify(execFile)("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
    ...["-f", "lavfi", "-i", "anoisesrc=sample_rate=48000:duration=2:seed=1"],
    ...["-c:a", "libopus", "-b:a", "96k", "-page_duration", "20000", filePath],
  ]);
  const server = await createMockHttpServer((req, res) =>
    streamSubsonicAudio(req, res, filePath, { format: "", maxBitRate: 320 }),
  );
  try {
    const response = await fetch(server.url);
    assert.equal(response.headers.get("content-type"), "audio/ogg");
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(await fs.readFile(filePath)));
  } finally {
    await server.close();
  }
});

test("format=flac serves an ALAC file as FLAC with byte ranges", async () => {
  const filePath = await alacFile("alac.m4a");
  const server = await createMockHttpServer((req, res) =>
    streamSubsonicAudio(req, res, filePath, { format: "flac", maxBitRate: 0 }),
  );
  try {
    const whole = await fetch(server.url);
    assert.equal(whole.headers.get("content-type"), "audio/flac");
    const bytes = Buffer.from(await whole.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "fLaC");

    const range = await fetch(server.url, {
      headers: { Range: "bytes=100-199", "If-Range": whole.headers.get("etag") ?? "" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 100-199/${bytes.length}`);
    assert.ok(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(100, 200)));
  } finally {
    await server.close();
  }
});

test("concurrent requests for one file share a single FLAC conversion", async () => {
  const source = await alacFile("concurrent.m4a");
  const copies = await Promise.all([flacCopy(source), flacCopy(source)]);
  assert.equal(copies[0], copies[1]);
  assert.equal((await fs.readFile(copies[0])).subarray(0, 4).toString(), "fLaC");
});

test("the FLAC cache drops the least recently used copies past its limit", async () => {
  const older = await flacCopy(await alacFile("older.m4a"));
  const newer = await flacCopy(await alacFile("newer.m4a"), 1);
  await assert.rejects(fs.stat(older));
  assert.ok((await fs.stat(newer)).isFile());
});
