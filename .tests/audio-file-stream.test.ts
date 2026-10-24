import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { audioContentType, sendAudioFile } from "../backend/services/audioFileStream.ts";
import { createMockHttpServer } from "./helpers/backendTestHarness.ts";

const audio = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-audio-file-"));
let server: Awaited<ReturnType<typeof createMockHttpServer>>;

beforeAll(async () => {
  await fs.writeFile(path.join(dir, "track.flac"), audio);
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

test("a byte range returns only those bytes", async () => {
  const { response, body } = await get("track.flac", range("bytes=10-19"));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "audio/flac");
  assert.deepEqual(body, audio.subarray(10, 20));

  const suffix = await get("track.flac", range("bytes=-5"));
  assert.equal(suffix.response.headers.get("content-range"), "bytes 95-99/100");
  assert.deepEqual(suffix.body, audio.subarray(95));

  const adjacent = await get("track.flac", range("bytes=0-1,2-3"));
  assert.equal(adjacent.response.headers.get("content-range"), "bytes 0-3/100");
});

test("ranges a single response cannot cover fall back to the whole file", async () => {
  const { response, body } = await get("track.flac", range("bytes=0-1,5-6"));
  assert.equal(response.status, 200);
  assert.deepEqual(body, audio);
});

test("a range past the end is unsatisfiable", async () => {
  const { response, body } = await get("track.flac", range("bytes=100-"));
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */100");
  assert.equal(body.length, 0);
});

test("HEAD answers with the headers a GET would send", async () => {
  const { response, body } = await get("track.flac", { method: "HEAD", ...range("bytes=10-19") });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(body.length, 0);
});

test("a cached copy is revalidated, and a stale If-Range gets the whole file", async () => {
  const { response } = await get("track.flac");
  const etag = response.headers.get("etag") ?? "";
  const revalidate = { "If-None-Match": etag, "Cache-Control": "max-age=0" };
  assert.equal((await get("track.flac", { headers: revalidate })).response.status, 304);

  const matching = await get("track.flac", { headers: { Range: "bytes=0-9", "If-Range": etag } });
  assert.equal(matching.response.status, 206);
  const stale = await get("track.flac", { headers: { Range: "bytes=0-9", "If-Range": '"old"' } });
  assert.equal(stale.response.status, 200);
  assert.deepEqual(stale.body, audio);
});

test("a missing file or a directory is left for the caller to answer", async () => {
  assert.equal((await get("missing.flac")).response.status, 404);
  assert.equal((await get("")).response.status, 404);
});
