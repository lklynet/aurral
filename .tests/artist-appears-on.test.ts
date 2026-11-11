import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test } from "vite-plus/test";

import appearsOn from "../backend/routes/artists/handlers/appearsOn.ts";
import { dbOps } from "../backend/db/helpers/index.ts";
import { json, stubFetch } from "./helpers/stubFetch.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";

useFakeClock();

const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";
const GUEST_HOST = "22222222-2222-4222-8222-222222222222";

const credit = (id: string, name: string) => [{ name, joinphrase: "", artist: { id, name } }];

const mbRelease = ({
  id,
  groupId,
  title,
  date,
  by,
}: {
  id: string;
  groupId: string;
  title: string;
  date: string;
  by: { name: string; joinphrase: string; artist: { id: string; name: string } }[];
}) => ({
  id,
  title,
  date,
  status: "Official",
  "artist-credit": by,
  "release-group": {
    id: groupId,
    title,
    "first-release-date": date,
    "primary-type": "Album",
    "secondary-types": [],
    "artist-credit": by,
  },
});

const isTrackArtistBrowse = (url: URL, mbid: string) =>
  url.hostname === "musicbrainz.org" &&
  url.pathname === "/ws/2/release" &&
  url.searchParams.get("track_artist") === mbid;

async function postAppearsOn(mbid: string, body: { limit?: number } = {}) {
  const response = await appearsOn.request(`/artists/${mbid}/appears-on`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("appears-on lists other artists' releases once each, newest first, and never the artist's own", async (t) => {
  const mbid = "33333333-3333-4333-8333-333333333333";
  const ownCredit = credit(mbid, "Guest Artist");
  stubFetch(t, (url) => {
    if (!isTrackArtistBrowse(url, mbid)) return json({}, 404);
    return json({
      "release-count": 4,
      "release-offset": 0,
      releases: [
        mbRelease({
          id: "r-comp",
          groupId: "rg-comp",
          title: "Hits of 1995",
          date: "1995-03-01",
          by: credit(VARIOUS_ARTISTS, "Various Artists"),
        }),
        mbRelease({
          id: "r-comp-reissue",
          groupId: "rg-comp",
          title: "Hits of 1995",
          date: "2001-06-01",
          by: credit(VARIOUS_ARTISTS, "Various Artists"),
        }),
        mbRelease({
          id: "r-own",
          groupId: "rg-own",
          title: "Own Album",
          date: "2020-01-01",
          by: ownCredit,
        }),
        mbRelease({
          id: "r-feature",
          groupId: "rg-feature",
          title: "Host Album",
          date: "2010-09-09",
          by: credit(GUEST_HOST, "Host Artist"),
        }),
      ],
    });
  });

  const response = await postAppearsOn(mbid, { limit: 24 });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map((item: { id: string }) => item.id),
    ["rg-feature", "rg-comp"],
  );
  assert.equal(response.body.items[1]["artist-credit"][0].name, "Various Artists");
  assert.equal(response.body.hasMore, false);
});

test("appears-on follows the artist's saved MusicBrainz ID", async (t) => {
  const mbid = "44444444-4444-4444-8444-444444444444";
  const corrected = "77777777-7777-4777-8777-777777777777";
  dbOps.setArtistOverride(mbid, { musicbrainzId: corrected, deezerArtistId: null });
  t.onTestFinished(() => {
    dbOps.deleteArtistOverride(mbid);
  });
  stubFetch(t, (url) => {
    if (!isTrackArtistBrowse(url, corrected)) return json({}, 404);
    return json({
      "release-count": 1,
      "release-offset": 0,
      releases: [
        mbRelease({
          id: "r-corrected",
          groupId: "rg-corrected",
          title: "Host Album",
          date: "2010-09-09",
          by: credit(GUEST_HOST, "Host Artist"),
        }),
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
    ["rg-corrected"],
  );
});

test("appears-on skips a release Aurral can't read and still pages by what MusicBrainz sent", async (t) => {
  const mbid = "55555555-5555-4555-8555-555555555555";
  const offsets: (string | null)[] = [];
  stubFetch(t, (url) => {
    if (!isTrackArtistBrowse(url, mbid)) return json({}, 404);
    offsets.push(url.searchParams.get("offset"));
    return json({
      "release-count": 2,
      "release-offset": 0,
      releases: [
        { id: "r-broken", title: "Broken", "release-group": { id: 7 } },
        mbRelease({
          id: "r-feature",
          groupId: "rg-readable",
          title: "Host Album",
          date: "2010-09-09",
          by: credit(GUEST_HOST, "Host Artist"),
        }),
      ],
    });
  });

  const response = await postAppearsOn(mbid, { limit: 24 });

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map((item: { id: string }) => item.id),
    ["rg-readable"],
  );
  assert.equal(response.body.hasMore, false);
  assert.deepEqual(offsets, ["0"]);
});

test("a failed MusicBrainz lookup reports an error and the next request retries", async (t) => {
  const mbid = "66666666-6666-4666-8666-666666666666";
  let musicbrainzUp = false;
  stubFetch(t, (url) => {
    if (!isTrackArtistBrowse(url, mbid)) return json({}, 404);
    if (!musicbrainzUp) return json({ error: "unavailable" }, 503);
    return json({
      "release-count": 1,
      "release-offset": 0,
      releases: [
        mbRelease({
          id: "r-feature",
          groupId: "rg-retry-feature",
          title: "Host Album",
          date: "2010-09-09",
          by: credit(GUEST_HOST, "Host Artist"),
        }),
      ],
    });
  });

  const failed = await postAppearsOn(mbid, { limit: 24 });
  assert.equal(failed.status, 502);

  musicbrainzUp = true;
  const retried = await postAppearsOn(mbid, { limit: 24 });
  assert.equal(retried.status, 200);
  assert.deepEqual(
    retried.body.items.map((item: { id: string }) => item.id),
    ["rg-retry-feature"],
  );
});

test("a busy MusicBrainz response is retried once after a pause", async (t) => {
  const mbid = "77777777-7777-4777-8777-777777777777";
  let requests = 0;
  stubFetch(t, (url) => {
    if (!isTrackArtistBrowse(url, mbid)) return json({}, 404);
    requests += 1;
    if (requests === 1) return json({ error: "busy" }, 503);
    return json({
      "release-count": 1,
      "release-offset": 0,
      releases: [
        mbRelease({
          id: "r-busy-feature",
          groupId: "rg-busy-feature",
          title: "Host Album",
          date: "2012-02-02",
          by: credit(GUEST_HOST, "Host Artist"),
        }),
      ],
    });
  });

  const result = await postAppearsOn(mbid, { limit: 24 });
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.items.map((item: { id: string }) => item.id),
    ["rg-busy-feature"],
  );
  assert.equal(requests, 2);
});
