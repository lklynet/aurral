import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";

import { readAurralIdentity, writeAudioMetadata } from "../../backend/services/downloadUtils.ts";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-ytdlp-metadata-"));

function createUntaggedM4a(name: string) {
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
  assert.equal(common.musicbrainz_releasegroupid, "22222222-2222-4222-8222-222222222222");
  assert.equal(common.musicbrainz_recordingid, "33333333-3333-4333-8333-333333333333");
  assert.equal(common.musicbrainz_albumid, undefined);
  assert.equal(common.grouping, undefined);
  assert.equal(common.comment, undefined);
  assert.deepEqual(readAurralIdentity(await parseFile(filePath)), {
    artistMbid: "11111111-1111-4111-8111-111111111111",
    albumMbid: "22222222-2222-4222-8222-222222222222",
    trackMbid: "33333333-3333-4333-8333-333333333333",
  });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("tags a downloaded M4A that carries a chapter track", async () => {
  const chapters = path.join(tempDir, "chapters.txt");
  await writeFile(
    chapters,
    ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Intro\n" +
      "[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=Song\n",
  );
  const filePath = path.join(tempDir, "chaptered.m4a");
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
      "-i",
      chapters,
      "-map",
      "0:a",
      "-map_chapters",
      "1",
      "-t",
      "1",
      "-c:a",
      "aac",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);

  await writeAudioMetadata(filePath, {
    trackName: "Within",
    artistName: "Daft Punk",
    albumName: "Random Access Memories",
  });

  const { common } = await parseFile(filePath);
  assert.equal(common.title, "Within");
  assert.equal(common.artist, "Daft Punk");
});
