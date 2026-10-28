import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vite-plus/test";

import axios from "../../lib/axiosFetch.ts";
import { lrclibCache, lrclibGetLyrics } from "../../backend/services/apiClients/lrclib.ts";

const song = { artist: "Radiohead", title: "Karma Police", album: "OK Computer", durationSec: 264 };

function lrclib(respond: () => { status: number; data: unknown } | Promise<never>) {
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(axios, "get").mockImplementation(async (url, config) => {
    assert.equal(url, "https://lrclib.net/api/get");
    requests.push({ ...(config?.params || {}) });
    return { statusText: "", headers: {}, ...(await respond()) };
  });
  return requests;
}

beforeEach(() => lrclibCache.flushAll());

test("LRCLIB lyrics prefer synced lines and send what Aurral knows about the track", async () => {
  const requests = lrclib(() => ({
    status: 200,
    data: { plainLyrics: "Karma police", syncedLyrics: "[00:01.00] Karma police" },
  }));
  assert.equal(await lrclibGetLyrics(song), "[00:01.00] Karma police");
  assert.deepEqual(requests, [
    {
      artist_name: "Radiohead",
      track_name: "Karma Police",
      album_name: "OK Computer",
      duration: 264,
    },
  ]);
});

test("LRCLIB has no lyrics for instrumentals", async () => {
  lrclib(() => ({ status: 200, data: { instrumental: true, plainLyrics: "" } }));
  assert.equal(await lrclibGetLyrics(song), null);
});

test("an LRCLIB miss is remembered and a failure is asked again", async () => {
  let failing = true;
  const requests = lrclib(() =>
    failing ? Promise.reject(new Error("LRCLIB unavailable")) : { status: 404, data: {} },
  );
  assert.equal(await lrclibGetLyrics(song), null);
  failing = false;
  assert.equal(await lrclibGetLyrics(song), null);
  assert.equal(await lrclibGetLyrics(song), null);
  assert.equal(requests.length, 2);
});
