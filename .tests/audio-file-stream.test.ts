import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { audioContentType, sendAudioFile } from "../backend/services/audioFileStream.ts";
import { sendFrom } from "../backend/services/fileResponses.ts";
import { createMockHttpServer } from "./helpers/backendTestHarness.ts";

const audio = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-audio-file-"));
let server: Awaited<ReturnType<typeof createMockHttpServer>>;

function sineWav(amplitude: number, seconds = 3, rate = 44100) {
  const samples = Int16Array.from({ length: rate * seconds }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * 1000 * index) / rate) * amplitude * 32767),
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}

beforeAll(async () => {
  await fs.writeFile(path.join(dir, "track.flac"), audio);
  await fs.writeFile(path.join(dir, "loud.wav"), sineWav(0.5));
  await fs.writeFile(path.join(dir, "quiet.wav"), sineWav(0.05));
  server = await createMockHttpServer(async (req, res) => {
    const filePath = path.join(dir, decodeURIComponent(req.url ?? ""));
    if (!(await sendAudioFile(req, res, filePath))) res.writeHead(404).end();
  });
});

afterAll(async () => {
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const get = async (file: string, init?: RequestInit) => {
  const response = await fetch(`${server.url}/${file}`, init);
  return { response, body: Buffer.from(await response.arrayBuffer()) };
};

const range = (value: string) => ({ headers: { Range: value } });

test("a format named like an Object method gets a generic audio type", () => {
  assert.equal(audioContentType("FLAC"), "audio/flac");
  assert.equal(audioContentType("constructor"), "audio/constructor");
  assert.equal(audioContentType("toString"), "audio/tostring");
});

test("a byte range comes back with the audio content type", async () => {
  const { response, body } = await get("track.flac", range("bytes=10-19"));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(response.headers.get("content-type"), "audio/flac");
  assert.deepEqual(body, audio.subarray(10, 20));
});

test("a range past the end is unsatisfiable", async () => {
  const { response, body } = await get("track.flac", range("bytes=100-"));
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */100");
  assert.equal(body.length, 0);
});

test("a failed precondition gets a 412 instead of an error", async () => {
  const { response, body } = await get("track.flac", { headers: { "If-Match": '"stale"' } });
  assert.equal(response.status, 412);
  assert.equal(body.length, 0);
});

test("a malformed path is left for the caller to answer", async () => {
  const site = await createMockHttpServer(async (req, res) => {
    if (!(await sendFrom(req, res, dir, req.url ?? "/"))) res.writeHead(404).end();
  });
  try {
    assert.equal((await fetch(`${site.url}/%E0%A4%A.flac`)).status, 404);
    assert.equal((await fetch(`${site.url}/track%00.flac`)).status, 404);
    assert.equal((await fetch(`${site.url}/track.flac`)).status, 200);
  } finally {
    await site.close();
  }
});

test("a missing file or a directory is left for the caller to answer", async () => {
  assert.equal((await get("missing.flac")).response.status, 404);
  assert.equal((await get("")).response.status, 404);
});

test("a HEAD request reports the file's measured loudness, and a changed file is measured again", async () => {
  const loudness = async (file: string) =>
    Number((await get(file, { method: "HEAD" })).response.headers.get("x-aurral-loudness"));
  const loud = await loudness("loud.wav");
  const quiet = await loudness("quiet.wav");
  assert.ok(Math.abs(loud - quiet - 20) < 0.5, `loud ${loud}, quiet ${quiet}`);
  assert.equal((await get("loud.wav")).response.headers.get("x-aurral-loudness"), null);

  await fs.writeFile(path.join(dir, "quiet.wav"), sineWav(0.5, 4));
  assert.ok(Math.abs((await loudness("quiet.wav")) - loud) < 0.5);
});
