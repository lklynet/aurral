import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test } from "vite-plus/test";

import details from "../backend/routes/artists/handlers/details.ts";
import { json, stubFetch } from "./helpers/stubFetch.ts";

const detailsClient = testClient(details);

test("artist details return release listener counts and dates from the v1 artist file without calling ListenBrainz", async (t) => {
  const mbid = "7e54d133-2525-4bc0-ae94-000000000001";
  let listenBrainzCalls = 0;
  stubFetch(t, (url) => {
    if (url.hostname === "api.listenbrainz.org") {
      listenBrainzCalls += 1;
      return json({});
    }
    if (url.pathname === `/v1/artist/${mbid}`) {
      return json({
        id: mbid,
        name: "Plaid",
        sortName: "Plaid",
        listeners: 300000,
        genres: ["Electronic"],
        images: [{ kind: "poster", url: "https://images.example/plaid.jpg" }],
        similar: [
          {
            id: "7e54d133-2525-4bc0-ae94-000000000002",
            name: "Autechre",
            score: 1.5,
            image: "https://images.example/autechre.jpg",
          },
        ],
        topTracks: [
          {
            recordingId: "rec-eeyen",
            title: "Eyen",
            albumId: "11000000-0000-4000-8000-000000000000",
            durationMs: 251_000,
            listeners: 1200,
          },
        ],
        appearsOn: [
          {
            id: "41000000-0000-4000-8000-000000000000",
            title: "Warp10+3",
            type: "Album",
            artistName: "Various Artists",
          },
          {
            id: "51000000-0000-4000-8000-000000000000",
            title: "Artificial Intelligence",
            type: "Album",
            artistName: "Various Artists",
          },
        ],
        albums: [
          {
            id: "11000000-0000-4000-8000-000000000000",
            title: "Double Figure",
            type: "Album",
            firstReleaseDate: "2001-05-28",
            cover: "https://coverartarchive.org/release/11/front-500.jpg",
            listeners: 4906,
          },
          {
            id: "21000000-0000-4000-8000-000000000000",
            title: "Not for Threes",
            type: "Album",
            firstReleaseDate: "1997-10-27",
            listeners: 2077,
          },
          {
            id: "31000000-0000-4000-8000-000000000000",
            title: "Double Figure",
            type: "Single",
            listeners: 0,
          },
        ],
      });
    }
    return json({}, 404);
  });

  const response = await detailsClient.artists[":mbid"].$get({
    param: { mbid },
    query: { appearsOnLimit: "1" },
  });
  const artist = await response.json();
  assert.ok("release-groups" in artist);
  assert.equal(listenBrainzCalls, 0);
  assert.deepEqual(
    artist["release-groups"].map((rg) => ({
      title: rg.title,
      type: rg["primary-type"],
      date: rg["first-release-date"],
      listenerCount: rg.listenerCount,
    })),
    [
      { title: "Double Figure", type: "Album", date: "2001-05-28", listenerCount: 4906 },
      { title: "Not for Threes", type: "Album", date: "1997-10-27", listenerCount: 2077 },
      { title: "Double Figure", type: "Single", date: null, listenerCount: null },
    ],
  );
  assert.equal(artist.listeners, 300000);
  assert.equal(artist.images.length, 1);
  assert.equal(artist.similar[0]?.name, "Autechre");
  assert.equal(artist.topTracks[0]?.title, "Eyen");
  assert.equal(artist.topTracks[0]?.album, "Double Figure");
  assert.equal(artist.topTracks[0]?.albumMbid, "11000000-0000-4000-8000-000000000000");
  assert.equal(artist.topTracks[0]?.trackMbid, "rec-eeyen");
  assert.ok(artist.topTracks[0]?.preview_url?.startsWith("/api/deezer/preview?"));
  assert.equal(artist["appears-on-release-groups"].length, 1);
  assert.equal(artist["appears-on-has-more"], true);
});
