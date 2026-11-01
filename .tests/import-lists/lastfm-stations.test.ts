import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import { parseLastfmStation } from "../../backend/services/importLists/lastfmTracks.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps }, { lastfmStationClient }, { updateListenHistory }] =
  await setupIsolatedBackend(
    "lastfm-stations",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/importLists/lastfmStations.ts"),
    () => import("../../backend/services/listeningHistory.ts"),
  );

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

test("parseLastfmStation maps tracks, durations, and skipped entries", () => {
  const { tracks, stats } = parseLastfmStation({
    playlist: [
      Object.assign(
        {
          name: "Song A",
          duration: 185,
          artists: [{ name: "Artist A" }],
          primary_album: { name: "Album A" },
        },
        { mbid: "lastfm-release-track-id" },
      ),
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
  assert.equal(tracks[0].trackMbid, null);
  assert.deepEqual(stats, { incomplete: 1, duplicate: 1 });
});

test("lastfmStationClient lists the three stations in a stable order", async () => {
  const calls: { url: string | URL | Request; options: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    calls.push({ url, options });
    const station = new URL(String(url)).pathname.split("/").pop();
    return Response.json({
      playlist: Array.from({ length: station === "recommended" ? 2 : 3 }, (_, index) => ({
        name: `${station}-${index}`,
        artists: [{ name: "Artist" }],
      })),
    });
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
    calls.map(({ url }) => new URL(String(url)).pathname),
    [
      "/player/station/user/user%2Bname/library",
      "/player/station/user/user%2Bname/mix",
      "/player/station/user/user%2Bname/recommended",
    ],
  );
  assert.equal(new Headers(calls[0].options?.headers).get("Accept"), "application/json");
});

test("lastfmStationClient reuses a Last.fm username from the profile", async () => {
  const user = userOps.createUser("profile-user", "hash");
  assert.ok(user != null);
  updateListenHistory(user.id, { lastfm: "profile-lastfm" });
  let requestedUrl = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    requestedUrl = String(url);
    return Response.json({
      playlist: [{ name: "Song", artists: [{ name: "Artist" }] }],
    });
  });

  const result = await lastfmStationClient.getStationTracks(user.id, "library", null);

  assert.equal(result.tracks.length, 1);
  assert.equal(result.user, "profile-lastfm");
  assert.equal(new URL(requestedUrl).pathname, "/player/station/user/profile-lastfm/library");
});
