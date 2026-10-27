import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";

import axios from "../../lib/axiosFetch.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { scrobbleConnectionStore }, { listenbrainzPlaylistClient }] =
  await setupIsolatedBackend(
    "listenbrainz-playlists",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/scrobbleConnectionStore.ts"),
    () => import("../../backend/services/importLists/listenbrainzPlaylists.ts"),
  );

beforeEach(() => resetDatabase(db));
afterAll(() => cleanupIsolatedState(isolatedState));

test("lists owned and created-for ListenBrainz playlists without duplicates", async () => {
  const playlistExtension = "https://musicbrainz.org/doc/jspf#playlist";
  const ownedId = "00000000-0000-4000-8000-000000000001";
  const oldExplorationId = "00000000-0000-4000-8000-000000000002";
  const explorationId = "00000000-0000-4000-8000-000000000003";
  const jamsId = "00000000-0000-4000-8000-000000000004";
  const noiseId = "00000000-0000-4000-8000-000000000005";
  const makeEntry = ({
    id,
    title,
    date,
    sourcePatch,
  }: {
    id: string;
    title: string;
    date?: string;
    sourcePatch?: string;
  }) => ({
    playlist: {
      identifier: `https://listenbrainz.org/playlist/${id}`,
      title,
      date,
      ...(sourcePatch
        ? {
            extension: {
              [playlistExtension]: {
                additional_metadata: {
                  algorithm_metadata: { source_patch: sourcePatch },
                },
              },
            },
          }
        : {}),
    },
  });
  scrobbleConnectionStore.saveConnection(7, "listenbrainz", {
    token: "test-token",
    displayName: "playlist-user",
  });
  const calls: {
    url: string;
    options: NonNullable<Parameters<typeof axios.get>[1]> | undefined;
  }[] = [];
  vi.spyOn(axios, "get").mockImplementation(async (url: string, options) => {
    calls.push({ url, options });
    if (url.includes("/1/playlist/")) {
      const id = new URL(String(url)).pathname.split("/").pop();
      assert.ok(id != null);
      const trackCount = new Map([
        [ownedId, 3],
        [explorationId, 7],
        [jamsId, 8],
      ]).get(id);
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          playlist: {
            track: Array.from({ length: trackCount || 0 }, () => ({})),
          },
        },
      };
    }
    if (url.endsWith("/playlists/createdfor")) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          playlist_count: 4,
          playlists: [
            makeEntry({
              id: oldExplorationId,
              title: "Weekly Exploration for playlist-user, week of 2026-07-01",
              date: "2026-07-01T00:00:00Z",
              sourcePatch: "weekly-exploration",
            }),
            makeEntry({
              id: explorationId,
              title: "Weekly Exploration for playlist-user, week of 2026-07-28",
              date: "2026-07-28T00:00:00Z",
              sourcePatch: "weekly-exploration",
            }),
            makeEntry({
              id: jamsId,
              title: "Weekly Jams for playlist-user, week of 2026-07-28",
              date: "2026-07-28T00:00:00Z",
              sourcePatch: "weekly-jams",
            }),
            makeEntry({
              id: noiseId,
              title: "Top Discoveries of 2025 for playlist-user",
              date: "2025-12-31T00:00:00Z",
            }),
          ],
        },
      };
    }
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: {
        playlist_count: 1,
        playlists: [makeEntry({ id: ownedId, title: "Mine" })],
      },
    };
  });

  const result = await listenbrainzPlaylistClient.listPlaylists(7);

  assert.deepEqual(result.playlists, [
    {
      id: ownedId,
      name: "Mine",
      trackCount: 3,
    },
    {
      id: jamsId,
      name: "Weekly Jams",
      sourceType: "weekly-jams",
      trackCount: 8,
    },
    {
      id: explorationId,
      name: "Weekly Exploration",
      sourceType: "weekly-exploration",
      trackCount: 7,
    },
  ]);
  assert.deepEqual(
    calls
      .filter(({ url }) => url.includes("/1/user/"))
      .map(({ url }) => new URL(String(url)).pathname),
    ["/1/user/playlist-user/playlists", "/1/user/playlist-user/playlists/createdfor"],
  );
  assert.equal(calls.filter(({ url }) => url.includes("/1/playlist/")).length, 3);
  assert.equal(calls[0].options!.headers!.Authorization, "Token test-token");
});

test("ListenBrainz playlist imports retain JSPF cover artwork", async () => {
  scrobbleConnectionStore.saveConnection(7, "listenbrainz", {
    token: "test-token",
    displayName: "playlist-user",
  });
  vi.spyOn(axios, "get").mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: {},
    data: {
      playlist: { title: "Playlist", image: "https://images.example.test/playlist.jpg", track: [] },
    },
  });
  const playlist = await listenbrainzPlaylistClient.getPlaylistTracks(
    7,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(playlist.artworkUrl, "https://images.example.test/playlist.jpg");
});
