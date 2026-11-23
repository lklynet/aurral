import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test } from "vite-plus/test";

import appearsOn from "../backend/routes/artists/handlers/appearsOn.ts";
import { dbOps } from "../backend/db/helpers/index.ts";
import { json, stubFetch } from "./helpers/stubFetch.ts";

const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";
const GUEST_HOST = "22222222-2222-4222-8222-222222222222";
const RG_FEATURE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const RG_COMP = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const RG_CORRECTED = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";

async function postAppearsOn(mbid: string, body: { limit?: number; excludeIds?: string[] } = {}) {
  const response = await appearsOn.request(`/artists/${mbid}/appears-on`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("appears-on serves the artist file's appearances and paginates with excludeIds", async (t) => {
  const mbid = "33333333-3333-4333-8333-333333333333";
  stubFetch(t, (url) => {
    if (url.pathname !== `/v1/artist/${mbid}`) return json({}, 404);
    return json({
      id: mbid,
      name: "Guest Artist",
      appearsOn: [
        {
          id: RG_FEATURE,
          title: "Host Album",
          type: "Album",
          firstReleaseDate: "2010-09-09",
          artistId: GUEST_HOST,
          artistName: "Host Artist",
        },
        {
          id: RG_COMP,
          title: "Hits of 1995",
          type: "Album",
          secondaryTypes: ["Compilation"],
          firstReleaseDate: "1995-03-01",
          artistId: VARIOUS_ARTISTS,
          artistName: "Various Artists",
        },
      ],
    });
  });

  const first = await postAppearsOn(mbid, { limit: 1 });
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.items.map((item: { id: string }) => item.id),
    [RG_FEATURE],
  );
  assert.equal(first.body.hasMore, true);

  const second = await postAppearsOn(mbid, { limit: 1, excludeIds: [RG_FEATURE] });
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.items.map((item: { id: string }) => item.id),
    [RG_COMP],
  );
  assert.equal(second.body.items[0]["artist-credit"][0].name, "Various Artists");
  assert.equal(second.body.hasMore, false);
});

test("appears-on follows the artist's saved MusicBrainz ID", async (t) => {
  const mbid = "44444444-4444-4444-8444-444444444444";
  const corrected = "77777777-7777-4777-8777-777777777777";
  dbOps.setArtistOverride(mbid, { musicbrainzId: corrected, deezerArtistId: null });
  t.onTestFinished(() => {
    dbOps.deleteArtistOverride(mbid);
  });
  stubFetch(t, (url) => {
    if (url.pathname !== `/v1/artist/${corrected}`) return json({}, 404);
    return json({
      id: corrected,
      name: "Corrected Artist",
      appearsOn: [
        {
          id: RG_CORRECTED,
          title: "Host Album",
          type: "Album",
          firstReleaseDate: "2010-09-09",
          artistId: GUEST_HOST,
          artistName: "Host Artist",
        },
      ],
    });
  });

  const response = await testClient(appearsOn).artists[":mbid"]["appears-on"].$post({
    param: { mbid },
    json: { limit: 24 },
  });
  const body = await response.json();

  assert.ok("items" in body);
  assert.deepEqual(
    body.items.map(({ id }) => id),
    [RG_CORRECTED],
  );
});
