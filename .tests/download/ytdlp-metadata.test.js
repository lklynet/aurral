import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";

import { writeAudioMetadata } from "../../backend/services/downloadUtils.js";

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
    ) ?? false,
    false,
  );
  assert.equal(
    common.grouping,
    'AURRAL_IDS={"artistMbid":"11111111-1111-4111-8111-111111111111","albumMbid":"22222222-2222-4222-8222-222222222222","trackMbid":"33333333-3333-4333-8333-333333333333"}',
  );
});

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
