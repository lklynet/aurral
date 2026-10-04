import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  discovery,
  { getUserDiscovery },
  { default: searchRouter },
  { registerSimilar },
  { FlowTrackSource },
] = await setupIsolatedBackend(
  "listenbrainz-discovery",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/discovery/index.js",
  "backend/services/discovery/userDiscovery.js",
  "backend/routes/search.js",
  "backend/routes/artists/handlers/similar.js",
  "backend/services/flows/flowTrackSource.js",
);

const mbid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const LIKED = { name: "Liked Artist", mbid: mbid(1) };
const LIBRARY = { name: "Library One", mbid: mbid(2) };
const CLOSE_PICK = { name: "Close Pick", mbid: mbid(11) };
const SHARED_PICK = { name: "Shared Pick", mbid: mbid(12) };
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

const similarBySeed = new Map([
  [LIKED.mbid, [
    { ...CLOSE_PICK, score: 900 },
    { ...SHARED_PICK, score: 450 },
    { ...LIBRARY, score: 300 },
  ]],
  [LIBRARY.mbid, [{ ...SHARED_PICK, score: 800 }]],
]);

const originalFetch = globalThis.fetch;
const originalLastfmApiKey = process.env.LASTFM_API_KEY;
let requests = [];
let alice;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const respond = (url) => {
  if (url.hostname === "labs.api.listenbrainz.org" && url.pathname === "/similar-artists/json") {
    const seed = url.searchParams.get("artist_mbids");
    return json((similarBySeed.get(seed) || []).map((artist) => ({
      artist_mbid: artist.mbid,
      name: artist.name,
      score: artist.score,
      reference_mbid: seed,
    })));
  }
  if (url.hostname === "api.listenbrainz.org" && url.pathname === "/1/metadata/artist/") {
    return json(url.searchParams.get("artist_mbids").split(",").map((artistMbid) => ({
      artist_mbid: artistMbid,
      tag: {
        artist: [
          { tag: "seen live", count: 9 },
          { tag: "shoegaze", count: 4 },
          { tag: "dream pop", count: 2 },
        ],
      },
    })));
  }
  if (url.hostname === "musicbrainz.org" && url.pathname === "/ws/2/artist") {
    return json({
      count: 3,
      artists: [
        { id: mbid(21), name: "Shoegaze Leader" },
        { id: VARIOUS_ARTISTS_MBID, name: "Various Artists" },
        { id: mbid(22), name: "Shoegaze Second" },
      ],
    });
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/search/artist") {
    return json({ data: [{ id: 8, name: "Library Onesie" }, { id: 7, name: "Library One" }] });
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/artist/7/top") {
    return json({ data: [{ title: "Hit Song", album: { title: "First Album" }, duration: 200, rank: 5000 }] });
  }
  return json({ error: "unexpected" }, 404);
};

test.before(() => {
  resetDatabase(db);
  delete process.env.LASTFM_API_KEY;
  dbOps.invalidateSettingsCache();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return respond(url);
  };
  db.prepare(
    `INSERT INTO library_artists (identity_key, mbid, name, created_at, updated_at)
     VALUES ('library-one', ?, ?, 1, 1)`,
  ).run(LIBRARY.mbid, LIBRARY.name);
  alice = userOps.createUser("alice", "hash");
  discovery.addDiscoveryFeedback(alice.id, {
    artistId: LIKED.mbid,
    artistName: LIKED.name,
    action: "more_like_this",
  });
});

test.beforeEach(() => {
  requests = [];
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  if (originalLastfmApiKey !== undefined) process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("without a Last.fm key each user gets personal recommendations from ListenBrainz", async () => {
  assert.equal((await discovery.updateUserDiscoveryCache(alice.id)).refreshed, true);

  const { body } = await getUserDiscovery(alice.id, 0);
  assert.equal(body.provider, "listenbrainz");
  assert.deepEqual(body.basedOn.map((artist) => artist.name).sort(), [LIBRARY.name, LIKED.name].sort());
  assert.deepEqual(body.recommendations.map((artist) => artist.name), [SHARED_PICK.name, CLOSE_PICK.name]);
  assert.equal(body.recommendations[0].seedCount, 2);
  assert.deepEqual([...body.topGenres].sort(), ["dream pop", "shoegaze"]);
  assert.equal(body.recommendations.some((artist) => artist.tags.includes("seen live")), false);
  assert.equal(requests.some((url) => url.hostname === "ws.audioscrobbler.com"), false);
});

const requestApi = async (mountPath, router, path) => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: alice.id, role: "user" };
    next();
  });
  app.use(mountPath, router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}${mountPath}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("without a Last.fm key tag search lists MusicBrainz's artists for the tag", async () => {
  const { status, body } = await requestApi("/api/search", searchRouter, "?scope=tag&q=%23shoegaze");

  assert.equal(status, 200);
  assert.deepEqual(body.items.map((artist) => artist.name), ["Shoegaze Leader", "Shoegaze Second"]);
  assert.equal(body.hasMore, false);
  const search = requests.find((url) => url.hostname === "musicbrainz.org");
  assert.equal(search.searchParams.get("query"), 'tag:"shoegaze"');
});

test("without a Last.fm key artist pages list ListenBrainz similar artists", async () => {
  let handler;
  registerSimilar({ get: (_path, ...handlers) => (handler = handlers.at(-1)) });
  let body;
  await handler(
    { params: { mbid: LIKED.mbid }, query: { artistName: LIKED.name } },
    { json: (value) => (body = value) },
  );

  assert.deepEqual(
    body.artists.map((artist) => [artist.name, artist.match]),
    [[CLOSE_PICK.name, 100], [SHARED_PICK.name, 50], [LIBRARY.name, 33]],
  );
});

test("without a Last.fm key a Mix flow picks the library artist's own Deezer top track", async () => {
  const plan = await new FlowTrackSource().buildFlowRunPlan({
    size: 1,
    mix: { discover: 0, mix: 100, trending: 0, focus: 0 },
  });

  assert.deepEqual(
    plan.primaryTracks.map((track) => [track.source, track.artistName, track.trackName, track.albumName]),
    [["mix", LIBRARY.name, "Hit Song", "First Album"]],
  );
  assert.equal(requests.some((url) => url.pathname === "/artist/8/top"), false);
});
