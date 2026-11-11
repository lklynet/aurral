import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import releaseGroup from "../../backend/routes/artists/handlers/releaseGroup.ts";
import { json, stubFetch } from "../helpers/stubFetch.ts";
import { useFakeClock } from "../helpers/fakeClock.ts";

useFakeClock();

const LEAD = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const STARS = "33333333-3333-4333-8333-333333333333";
const BLACK_PANTHER = "44444444-4444-4444-8444-444444444444";

const credits = (releaseMbid: string) =>
  releaseGroup.request(`/artists/release/${releaseMbid}/credits`);

test("a release's track credits name each track's guests, keyed by recording", async (t) => {
  const releaseMbid = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  stubFetch(t, (url) =>
    url.pathname === `/ws/2/release/${releaseMbid}`
      ? json({
          media: [
            {
              tracks: [
                {
                  "artist-credit": [
                    { name: "Kendrick Lamar", joinphrase: " & ", artist: { id: LEAD } },
                    { name: "SZA", artist: { id: GUEST } },
                  ],
                  recording: { id: STARS },
                },
                {
                  recording: {
                    id: BLACK_PANTHER,
                    "artist-credit": [{ name: "Kendrick Lamar", artist: { id: LEAD } }],
                  },
                },
              ],
            },
          ],
        })
      : json({}, 404),
  );

  const response = await credits(releaseMbid);

  assert.equal(response.headers.get("cache-control"), "private, max-age=86400");
  assert.deepEqual(await response.json(), {
    credits: {
      [STARS]: [
        { name: "Kendrick Lamar", mbid: LEAD, joinPhrase: " & " },
        { name: "SZA", mbid: GUEST, joinPhrase: "" },
      ],
      [BLACK_PANTHER]: [{ name: "Kendrick Lamar", mbid: LEAD, joinPhrase: "" }],
    },
  });
});

test("a release's track credits stay out of the browser cache when MusicBrainz fails", async (t) => {
  stubFetch(t, () => json({}, 500));

  const response = await credits("b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { credits: {} });
});
