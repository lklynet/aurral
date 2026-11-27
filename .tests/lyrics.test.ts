import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";

import { http } from "../lib/http.ts";
import { lrclibCache } from "../backend/services/apiClients/lrclib.ts";
import { findTrackLyrics, saveSidecarLyrics } from "../backend/services/lyricsService.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lyrics-"));
process.env.DOWNLOAD_FOLDER = dir;
const filePath = path.join(dir, "01 Low Tide.flac");
const track = {
  artist: "Harbor Lights",
  title: "Low Tide",
  album: "Small Hours",
  durationSec: 201,
};

function lrclib(data: unknown) {
  const requests: unknown[] = [];
  vi.spyOn(http, "get").mockImplementation(async (_url, config) => {
    requests.push(config?.query);
    return { status: data ? 200 : 404, statusText: "", headers: {}, data: data ?? {} };
  });
  return requests;
}

beforeEach(async () => {
  lrclibCache.flushAll();
  vi.restoreAllMocks();
  await fs.rm(path.join(dir, "01 Low Tide.lrc"), { force: true });
});

afterAll(() => fs.rm(dir, { recursive: true, force: true }));

test("a sidecar .lrc wins over LRCLIB and its offset moves every line earlier", async () => {
  const requests = lrclib({ syncedLyrics: "[00:01.00] From LRCLIB" });
  await fs.writeFile(
    path.join(dir, "01 Low Tide.lrc"),
    "[offset:500]\n[00:02.00]Salt on the window\n[00:00.20]Intro\n",
  );
  assert.deepEqual(await findTrackLyrics({ ...track, filePath }), {
    synced: true,
    lines: [
      { start: 0, value: "Intro" },
      { start: 1500, value: "Salt on the window" },
    ],
  });
  assert.equal(requests.length, 0);
});

test("a track with no local lyrics is looked up on LRCLIB by what the player knows", async () => {
  const requests = lrclib({ plainLyrics: "Salt on the window\nLow tide" });
  assert.deepEqual(await findTrackLyrics(track), {
    synced: false,
    lines: [
      { start: undefined, value: "Salt on the window" },
      { start: undefined, value: "Low tide" },
    ],
  });
  assert.deepEqual(requests, [
    {
      artist_name: "Harbor Lights",
      track_name: "Low Tide",
      album_name: "Small Hours",
      duration: 201,
    },
  ]);
});

test("no lyrics anywhere is null", async () => {
  lrclib(null);
  assert.equal(await findTrackLyrics({ ...track, filePath }), null);
});

const sidecar = path.join(dir, "01 Low Tide.lrc");
const readSidecar = () => fs.readFile(sidecar, "utf8").catch(() => null);

test("a newly added track gets LRCLIB's lyrics saved as its sidecar .lrc", async () => {
  const requests = lrclib({ syncedLyrics: "[00:01.00] Salt on the window\n" });
  assert.equal(await saveSidecarLyrics(filePath, track), true);
  assert.equal(await readSidecar(), "[00:01.00] Salt on the window\n");
  assert.deepEqual(requests, [
    { artist_name: "Harbor Lights", track_name: "Low Tide", album_name: "Small Hours" },
  ]);
  assert.deepEqual(await findTrackLyrics({ ...track, filePath }), {
    synced: true,
    lines: [{ start: 1000, value: "Salt on the window" }],
  });
});

test("an existing sidecar is never replaced and LRCLIB isn't asked", async () => {
  const requests = lrclib({ syncedLyrics: "[00:01.00] From LRCLIB" });
  await fs.writeFile(sidecar, "[00:02.00]Mine\n");
  assert.equal(await saveSidecarLyrics(filePath, track), false);
  assert.equal(await readSidecar(), "[00:02.00]Mine\n");
  assert.equal(requests.length, 0);
});

test("no sidecar is written outside the Library folder, when LRCLIB has nothing or calls it instrumental, or the track has no title", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-lyrics-outside-"));
  const asked = lrclib({ plainLyrics: "Words" });
  assert.equal(await saveSidecarLyrics(path.join(outside, "01 Low Tide.flac"), track), false);
  assert.deepEqual([asked.length, await fs.readdir(outside)], [0, []]);
  await fs.rm(outside, { recursive: true });
  vi.restoreAllMocks();
  lrclib(null);
  assert.equal(await saveSidecarLyrics(filePath, track), false);
  lrclibCache.flushAll();
  vi.restoreAllMocks();
  lrclib({ instrumental: true, plainLyrics: "" });
  assert.equal(await saveSidecarLyrics(filePath, track), false);
  const requests = lrclib({ plainLyrics: "Words" });
  assert.equal(await saveSidecarLyrics(filePath, { ...track, title: " " }), false);
  assert.equal(requests.length, 0);
  assert.equal(await readSidecar(), null);
});
