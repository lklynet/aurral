import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test } from "vite-plus/test";

import releaseGroup from "../../backend/routes/artists/handlers/releaseGroup.ts";
import { json, stubFetch } from "../helpers/stubFetch.ts";

const LEAD = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const STARS = "33333333-3333-4333-8333-333333333333";
const BLACK_PANTHER = "44444444-4444-4444-8444-444444444444";

test("release-group tracks include each track's artist credits and popular flag straight from v1 album metadata", async (t) => {
  const albumMbid = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
  const releaseMbid = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  let mbCalls = 0;
  stubFetch(t, (url) => {
    if (url.hostname === "musicbrainz.org") {
      mbCalls += 1;
      return json({}, 404);
    }
    if (url.pathname === `/v1/album/${albumMbid}`) {
      return json({
        id: albumMbid,
        title: "Black Panther: The Album",
        artistId: LEAD,
        artists: [
          { id: LEAD, name: "Kendrick Lamar" },
          { id: GUEST, name: "SZA" },
        ],
        releases: [
          {
            id: releaseMbid,
            status: "Official",
            tracks: [
              {
                id: "track-1",
                recordingId: STARS,
                title: "All the Stars",
                trackPosition: 1,
                mediumNumber: 1,
                artistId: LEAD,
                popular: true,
                credits: [
                  { id: LEAD, name: "Kendrick Lamar", joinPhrase: " & " },
                  { id: GUEST, name: "SZA", joinPhrase: "" },
                ],
              },
              {
                id: "track-2",
                recordingId: BLACK_PANTHER,
                title: "Black Panther",
                trackPosition: 2,
                mediumNumber: 1,
                artistId: LEAD,
              },
            ],
          },
        ],
      });
    }
    return json({}, 404);
  });

  const response = await testClient(releaseGroup).artists["release-group"][":mbid"].tracks.$get({
    param: { mbid: albumMbid },
    query: {},
  });
  assert.equal(response.status, 200);
  const tracks = await response.json();
  assert.ok(Array.isArray(tracks));
  assert.equal(mbCalls, 0);
  assert.deepEqual(
    tracks.map((track) => [track.mbid, track.credits, track.popular]),
    [
      [
        STARS,
        [
          { name: "Kendrick Lamar", mbid: LEAD, joinPhrase: " & " },
          { name: "SZA", mbid: GUEST, joinPhrase: "" },
        ],
        true,
      ],
      [BLACK_PANTHER, [{ name: "Kendrick Lamar", mbid: LEAD, joinPhrase: "" }], false],
    ],
  );
});
