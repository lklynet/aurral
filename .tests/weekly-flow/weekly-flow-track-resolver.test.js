import test from "node:test";
import assert from "node:assert/strict";
import axios from "../../lib/axiosFetch.js";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";
import { clearMetadataProviderCaches } from "../../backend/services/providers/brainzmashProvider.js";
import { pickResolvedDurationMs } from "../../backend/services/providers/brainzmashRanking.js";

const [isolatedState, { dbOps }, { resolveWeeklyFlowTrackContext }] =
  await setupIsolatedBackend(
    "weekly-flow-track-resolver",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowTrackResolver.js",
  );

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("pickResolvedDurationMs prefers Last.fm only when albums agree", () => {
  assert.equal(
    pickResolvedDurationMs({
      playlistDurationMs: 282973,
      lastfmDurationMs: 207000,
      lastfmAlbumName: "Stages: Volume III",
      albumName: "Stages: Volume III",
      matchedTrackDurationMs: 282973,
    }),
    207000,
  );
  assert.equal(
    pickResolvedDurationMs({
      playlistDurationMs: 282973,
      lastfmDurationMs: 207000,
      lastfmAlbumName: "Other",
      albumName: "Stages: Volume III",
    }),
    282973,
  );
  assert.equal(
    pickResolvedDurationMs({
      playlistDurationMs: 282973,
      lastfmDurationMs: 207000,
      lastfmAlbumName: "",
      albumName: "Stages: Volume III",
    }),
    282973,
  );
  assert.equal(
    pickResolvedDurationMs({ lastfmDurationMs: null, matchedTrackDurationMs: 207000 }),
    207000,
  );
});

test("pickResolvedDurationMs replaces a stale playlist duration with the matched release duration", () => {
  assert.equal(
    pickResolvedDurationMs({
      playlistDurationMs: 524773,
      albumName: "Jet Set Radio Future SEGA Original Tracks",
      matchedTrackDurationMs: 222813,
    }),
    222813,
  );
});

test("resolveWeeklyFlowTrackContext replaces a stale album MBID before resolving duration", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: "https://brainzmash.example.test",
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });

  t.mock.method(axios, "get", async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/search/album") {
      return {
        data: options?.params?.artist
          ? [
              {
                id: "wrong-album",
                title: "Jet Set Radio",
                artistid: "wrong-artist",
                artists: [{ id: "wrong-artist", artistname: "Vulgar Unicorn" }],
              },
            ]
          : [
              {
                id: "correct-album",
                title: "Jet Set Radio Future Original Sound Tracks",
                artistid: "correct-artist",
                artists: [{ id: "correct-artist", artistname: "長沼英樹" }],
                releasedate: "2002-03-20",
              },
            ],
      };
    }
    if (path === "/album/wrong-album") {
      return {
        data: {
          id: "wrong-album",
          title: "Jet Set Radio",
          artistid: "wrong-artist",
          artists: [{ id: "wrong-artist", artistname: "Vulgar Unicorn" }],
          releases: [
            {
              id: "wrong-release",
              status: "Official",
              tracks: [
                {
                  trackname: "I Saw the Messenger of the New God There",
                  trackposition: 4,
                  durationms: 524773,
                  recordingid: "wrong-track",
                },
              ],
            },
          ],
        },
      };
    }
    if (path === "/album/correct-album") {
      return {
        data: {
          id: "correct-album",
          title: "Jet Set Radio Future Original Sound Tracks",
          artistid: "correct-artist",
          artists: [{ id: "correct-artist", artistname: "長沼英樹" }],
          releasedate: "2002-03-20",
          releases: [
            {
              id: "correct-release",
              status: "Official",
              releasedate: "2002-03-20",
              tracks: [
                {
                  trackname: "The Concept of Love",
                  trackposition: 1,
                  durationms: 222813,
                  recordingid: "correct-track",
                },
              ],
            },
          ],
        },
      };
    }
    return { data: {} };
  });

  const resolved = await resolveWeeklyFlowTrackContext({
    artistName: "Hideki Naganuma",
    trackName: "The Concept of Love",
    albumName: "Jet Set Radio Future SEGA Original Tracks",
    artistMbid: "wrong-artist",
    albumMbid: "wrong-album",
    durationMs: 524773,
    trackNumber: 4,
  });

  assert.equal(resolved.albumMbid, "correct-album");
  assert.equal(resolved.durationMs, 222813);
  assert.equal(resolved.trackNumber, 1);
  assert.deepEqual(resolved.albumTrackTitles, ["The Concept of Love"]);
});
