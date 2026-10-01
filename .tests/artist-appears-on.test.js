import assert from "node:assert/strict";
import test from "node:test";

import { registerAppearsOn } from "../backend/routes/artists/handlers/appearsOn.js";
import { registerStream } from "../backend/routes/artists/handlers/stream.js";

const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";
const GUEST_HOST = "22222222-2222-4222-8222-222222222222";

const credit = (id, name) => [{ name, joinphrase: "", artist: { id, name } }];

const mbRelease = ({ id, groupId, title, date, by }) => ({
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => handler(new URL(String(url)));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

const isTrackArtistBrowse = (url, mbid) =>
  url.hostname === "musicbrainz.org" &&
  url.pathname === "/ws/2/release" &&
  url.searchParams.get("track_artist") === mbid;

async function postAppearsOn(mbid, body = {}) {
  const routes = new Map();
  registerAppearsOn({
    post(path, handler) {
      routes.set(path, handler);
    },
  });
  let statusCode = 200;
  let payload;
  await routes.get("/:mbid/appears-on")(
    { params: { mbid }, body },
    {
      writableEnded: false,
      on() {},
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        payload = value;
        this.writableEnded = true;
        return this;
      },
    },
  );
  return { statusCode, body: payload };
}

function openStream(mbid) {
  const routes = new Map();
  registerStream({
    get(path, ...handlers) {
      routes.set(path, handlers.at(-1));
    },
  });
  const writes = [];
  let closeStream = () => {};
  routes.get("/:mbid/stream")(
    {
      params: { mbid },
      query: { artistName: "Guest Artist", appearsOnLimit: "24" },
      headers: {},
      socket: { destroyed: false },
      on(event, handler) {
        if (event === "close") closeStream = handler;
      },
    },
    {
      setHeader() {},
      status() {
        return this;
      },
      json() {
        return this;
      },
      write(value) {
        writes.push(value);
      },
      flush() {},
      end() {},
    },
  );
  const events = () => {
    const parsed = [];
    for (let index = 0; index + 1 < writes.length; index += 2) {
      parsed.push({
        event: writes[index].slice("event: ".length).trim(),
        data: JSON.parse(writes[index + 1].slice("data: ".length)),
      });
    }
    return parsed;
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const match = events().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("stream event did not arrive");
  };
  return { events, waitFor, close: () => closeStream() };
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
        mbRelease({ id: "r-comp", groupId: "rg-comp", title: "Hits of 1995", date: "1995-03-01", by: credit(VARIOUS_ARTISTS, "Various Artists") }),
        mbRelease({ id: "r-comp-reissue", groupId: "rg-comp", title: "Hits of 1995", date: "2001-06-01", by: credit(VARIOUS_ARTISTS, "Various Artists") }),
        mbRelease({ id: "r-own", groupId: "rg-own", title: "Own Album", date: "2020-01-01", by: ownCredit }),
        mbRelease({ id: "r-feature", groupId: "rg-feature", title: "Host Album", date: "2010-09-09", by: credit(GUEST_HOST, "Host Artist") }),
      ],
    });
  });

  const response = await postAppearsOn(mbid, { limit: 24 });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.body.items.map((item) => item.id),
    ["rg-feature", "rg-comp"],
  );
  assert.equal(response.body.items[1]["artist-credit"][0].name, "Various Artists");
  assert.equal(response.body.hasMore, false);
});

test("artist stream sends appearances without waiting for the discography", async (t) => {
  const mbid = "44444444-4444-4444-8444-444444444444";
  let releaseDiscography;
  const discographyGate = new Promise((resolve) => {
    releaseDiscography = resolve;
  });
  stubFetch(t, async (url) => {
    if (isTrackArtistBrowse(url, mbid)) {
      return json({
        "release-count": 1,
        "release-offset": 0,
        releases: [
          mbRelease({ id: "r-feature", groupId: "rg-stream-feature", title: "Host Album", date: "2010-09-09", by: credit(GUEST_HOST, "Host Artist") }),
        ],
      });
    }
    if (url.pathname === `/artist/${mbid}`) await discographyGate;
    return json({}, 404);
  });

  const stream = openStream(mbid);
  t.after(() => {
    releaseDiscography();
    stream.close();
  });

  const appearsOn = await stream.waitFor(
    ({ event, data }) => event === "artist" && "appears-on-release-groups" in data,
  );
  assert.deepEqual(
    appearsOn.data["appears-on-release-groups"].map((item) => item.id),
    ["rg-stream-feature"],
  );
  assert.equal(
    stream.events().some(({ data }) => "release-groups" in data),
    false,
  );

  releaseDiscography();
  await stream.waitFor(({ event }) => event === "complete");
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
        mbRelease({ id: "r-feature", groupId: "rg-retry-feature", title: "Host Album", date: "2010-09-09", by: credit(GUEST_HOST, "Host Artist") }),
      ],
    });
  });

  const failed = await postAppearsOn(mbid, { limit: 24 });
  assert.equal(failed.statusCode, 502);

  musicbrainzUp = true;
  const retried = await postAppearsOn(mbid, { limit: 24 });
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(retried.body.items.map((item) => item.id), ["rg-retry-feature"]);
});
