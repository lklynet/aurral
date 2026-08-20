import test from "node:test";
import assert from "node:assert/strict";

import { parseLastfmStation } from "../../backend/services/importLists/lastfmTracks.js";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, { lastfmStationClient }] = await setupIsolatedBackend(
  "lastfm-stations",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/importLists/lastfmStations.js",
);

test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(isolatedState));

test("parseLastfmStation maps tracks, durations, and skipped entries", () => {
  const { tracks, stats } = parseLastfmStation({
    playlist: [
      {
        name: "Song A",
        duration: 185,
        artists: [{ name: "Artist A" }],
        primary_album: { name: "Album A" },
      },
      {
        name: "Song A",
        duration: 185,
        artists: [{ name: "Artist A" }],
        primary_album: { name: "Album A" },
      },
      { name: "Missing Artist" },
    ],
  });

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].durationMs, 185000);
  assert.equal(tracks[0].artistName, "Artist A");
  assert.deepEqual(stats, { incomplete: 1, duplicate: 1 });
});

test("lastfmStationClient lists the three stations in a stable order", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    const station = new URL(url).pathname.split("/").pop();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        playlist: Array.from({ length: station === "recommended" ? 2 : 3 }, (_, index) => ({
          name: `${station}-${index}`,
          artists: [{ name: "Artist" }],
        })),
      }),
    };
  });

  const result = await lastfmStationClient.listPlaylists(7, "user+name");

  assert.deepEqual(
    result.playlists.map(({ id, name, trackCount }) => ({ id, name, trackCount })),
    [
      { id: "library", name: "Library", trackCount: 3 },
      { id: "mix", name: "Mix", trackCount: 3 },
      { id: "recommended", name: "Recommended", trackCount: 2 },
    ],
  );
  assert.equal(result.user, "user+name");
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      "/player/station/user/user%2Bname/library",
      "/player/station/user/user%2Bname/mix",
      "/player/station/user/user%2Bname/recommended",
    ],
  );
  assert.equal(calls[0].options.headers.Accept, "application/json");
});

test("lastfmStationClient reuses a Last.fm username from the profile", async (t) => {
  const user = userOps.createUser("profile-user", "hash");
  userOps.updateUser(user.id, {
    listenHistoryProvider: "lastfm",
    listenHistoryUsername: "profile-lastfm",
  });
  let requestedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        playlist: [{ name: "Song", artists: [{ name: "Artist" }] }],
      }),
    };
  });

  const result = await lastfmStationClient.getStationTracks(user.id, "library");

  assert.equal(result.tracks.length, 1);
  assert.equal(result.user, "profile-lastfm");
  assert.equal(new URL(requestedUrl).pathname, "/player/station/user/profile-lastfm/library");
});
