import test from "node:test";
import assert from "node:assert/strict";

import axios from "../../lib/axiosFetch.js";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { scrobbleConnectionStore }, { listenbrainzPlaylistClient }] =
  await setupIsolatedBackend(
    "listenbrainz-playlists",
    "backend/config/db-sqlite.js",
    "backend/services/scrobbleConnectionStore.js",
    "backend/services/importLists/listenbrainzPlaylists.js",
  );

test.beforeEach(() => resetDatabase(db));
test.after(() => cleanupIsolatedState(isolatedState));

test("lists owned and created-for ListenBrainz playlists without duplicates", async (t) => {
  const playlistExtension = "https://musicbrainz.org/doc/jspf#playlist";
  const ownedId = "00000000-0000-4000-8000-000000000001";
  const oldExplorationId = "00000000-0000-4000-8000-000000000002";
  const explorationId = "00000000-0000-4000-8000-000000000003";
  const jamsId = "00000000-0000-4000-8000-000000000004";
  const noiseId = "00000000-0000-4000-8000-000000000005";
  const makeEntry = ({ id, title, date, sourcePatch }) => ({
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
  const calls = [];
  t.mock.method(axios, "get", async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/1/playlist/")) {
      const id = new URL(url).pathname.split("/").pop();
      const trackCount = new Map([
        [ownedId, 3],
        [explorationId, 7],
        [jamsId, 8],
      ]).get(id);
      return {
        data: {
          playlist: {
            track: Array.from({ length: trackCount || 0 }, () => ({})),
          },
        },
      };
    }
    if (url.endsWith("/playlists/createdfor")) {
      return {
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
      data: {
        playlist_count: 1,
        playlists: [
          makeEntry({ id: ownedId, title: "Mine" }),
        ],
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
      .map(({ url }) => new URL(url).pathname),
    [
      "/1/user/playlist-user/playlists",
      "/1/user/playlist-user/playlists/createdfor",
    ],
  );
  assert.equal(calls.filter(({ url }) => url.includes("/1/playlist/")).length, 3);
  assert.equal(calls[0].options.headers.Authorization, "Token test-token");
});
