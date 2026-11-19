import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vite-plus/test";
import { streamSubsonicAudio } from "../../backend/services/subsonicTranscodeService.ts";
import { createMockHttpServer } from "../helpers/backendTestHarness.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-transcode-"));

afterAll(() => fs.rm(dir, { recursive: true, force: true }));

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
