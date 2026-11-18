import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { listenbrainzSubmit } from "../../backend/services/apiClients/listenbrainz.ts";
import { requireFixture } from "../playlists/fixtures.ts";

test("submits only real MusicBrainz IDs, with the album as a release group", async (t: import("vite-plus/test").TestContext) => {
  const originalFetch = globalThis.fetch;
  let submitted:
    | {
        payload: {
          track_metadata: {
            additional_info: {
              release_group_mbid?: string;
              release_mbid?: string;
              recording_mbid?: string;
              artist_mbids?: string[];
            };
          };
        }[];
      }
    | undefined;
  globalThis.fetch = async (_url, options) => {
    submitted = JSON.parse(String(options?.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });

  await listenbrainzSubmit({
    token: "test-token",
    event: {
      playedAt: 1_700_000_000_000,
      artist: "Example Artist",
      title: "Example Track",
      album: "Example Album",
      albumMbid: "22222222-2222-4222-8222-222222222222",
      artistMbid: "11111111-1111-4111-8111-111111111111",
      trackMbid: "908604612",
    },
  });

  assert.ok(submitted);
  const info = requireFixture(submitted.payload[0]).track_metadata.additional_info;
  assert.equal(info.release_group_mbid, "22222222-2222-4222-8222-222222222222");
  assert.equal(info.release_mbid, undefined);
  assert.deepEqual(info.artist_mbids, ["11111111-1111-4111-8111-111111111111"]);
  assert.equal(info.recording_mbid, undefined);
});
