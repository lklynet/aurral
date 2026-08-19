import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";

import {
  repairYtdlpMetadata,
  writeAudioMetadata,
} from "../../backend/services/playlistDownloadUtils.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-metadata-"));

function createUntaggedM4a(name) {
  const filePath = path.join(tempDir, name);
  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc",
      "-t",
      "0.05",
      "-c:a",
      "aac",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  return filePath;
}

test("yt-dlp output receives Aurral's canonical Navidrome tags", async () => {
  const filePath = createUntaggedM4a("new-track.m4a");
  await writeAudioMetadata(filePath, {
    trackName: "Bonzo Goes to Bitburg",
    artistName: "Ramones",
    albumName: "Animal Boy",
    artistMbid: "11111111-1111-4111-8111-111111111111",
    albumMbid: "22222222-2222-4222-8222-222222222222",
    trackMbid: "33333333-3333-4333-8333-333333333333",
    releaseYear: "1986",
    trackNumber: 5,
  });

  const { common } = await parseFile(filePath);
  assert.equal(common.title, "Bonzo Goes to Bitburg");
  assert.equal(common.artist, "Ramones");
  assert.equal(common.albumartist, "Ramones");
  assert.equal(common.album, "Animal Boy");
  assert.equal(common.year, 1986);
  assert.equal(common.track.no, 5);
  assert.equal(
    common.comment?.some((entry) =>
      String(entry?.text || entry).includes(
        'AURRAL_IDS={"artistMbid":"11111111-1111-4111-8111-111111111111","albumMbid":"22222222-2222-4222-8222-222222222222","trackMbid":"33333333-3333-4333-8333-333333333333"}',
      ),
    ),
    true,
  );
});

test("startup repair tags existing completed yt-dlp M4As", async () => {
  const filePath = createUntaggedM4a("existing-track.m4a");
  const jobs = [
    {
      status: "done",
      downloadClient: "ytdlp",
      finalPath: filePath,
      trackName: "Dead And Lovely",
      artistName: "Tom Waits",
      albumName: "Real Gone (Original Version)",
      artistMbid: "44444444-4444-4444-8444-444444444444",
      albumMbid: "55555555-5555-4555-8555-555555555555",
      trackMbid: "66666666-6666-4666-8666-666666666666",
      releaseYear: "2004",
      trackNumber: 2,
    },
  ];
  const result = await repairYtdlpMetadata(jobs);

  assert.deepEqual(result, { scanned: 1, repaired: 1, failed: 0 });
  const { common } = await parseFile(filePath);
  assert.equal(common.title, "Dead And Lovely");
  assert.equal(common.artist, "Tom Waits");
  assert.equal(common.albumartist, "Tom Waits");
  assert.equal(common.album, "Real Gone (Original Version)");
  assert.deepEqual(await repairYtdlpMetadata(jobs), {
    scanned: 1,
    repaired: 0,
    failed: 0,
  });
});

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
