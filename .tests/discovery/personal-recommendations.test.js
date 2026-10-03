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
  playEvents,
  { sampleLibraryArtistsForDiscovery },
  { default: discoveryRouter },
  { default: searchRouter },
  { WeeklyFlowPlaylistSource },
] = await setupIsolatedBackend(
  "personal-recommendations",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/discovery/index.js",
  "backend/services/discovery/userDiscovery.js",
  "backend/services/playEventService.js",
  "backend/services/libraryQueryService.js",
  "backend/routes/discovery/index.js",
  "backend/routes/search.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistSource.js",
);

const mbid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const LIKED = { name: "Liked Artist", mbid: mbid(1) };
const BLOCKED = { name: "Blocked Artist", mbid: mbid(2) };
const LIBRARY = { name: "Library One", mbid: mbid(3) };
const FROM_LIKED = { name: "From Liked", mbid: mbid(11) };
const FROM_PLAYED = { name: "From Played", mbid: mbid(12) };
const FROM_LIBRARY = { name: "From Library", mbid: mbid(13) };
const FROM_DISLIKED = { name: "From Disliked", mbid: mbid(14) };
const SHOEGAZE_TOP_ARTISTS = [
  { name: "Shoegaze Leader", mbid: mbid(21) },
  FROM_PLAYED,
  { name: "Shoegaze Third", mbid: mbid(22) },
];

const similarBySeed = new Map([
  [LIKED.mbid, [FROM_LIKED, BLOCKED, LIBRARY]],
  ["Played Artist", [FROM_PLAYED]],
  [LIBRARY.mbid, [FROM_LIBRARY]],
  ["Disliked Artist", [FROM_DISLIKED]],
]);

const originalFetch = globalThis.fetch;
const originalLastfmApiKey = process.env.LASTFM_API_KEY;
let alice;
let bob;

const lastfmResponse = (url) => {
  const params = new URL(url).searchParams;
  const seed = params.get("mbid") || params.get("artist");
  if (params.get("method") === "artist.getTopTags") {
    return { toptags: { tag: ["female vocalists", "shoegaze", "seen live", "dream-pop", "indie"].map((name) => ({ name, count: 100 })) } };
  }
  if (params.get("method") === "tag.getTopArtists") {
    return {
      topartists: {
        artist: SHOEGAZE_TOP_ARTISTS.map((artist) => ({ ...artist, image: [] })),
        "@attr": { total: String(SHOEGAZE_TOP_ARTISTS.length) },
      },
    };
  }
  if (params.get("method") === "artist.getSimilar") {
    return {
      similarartists: {
        artist: (similarBySeed.get(seed) || []).map((artist) => ({ ...artist, match: "0.9" })),
      },
    };
  }
  return {};
};

const play = (userId, artist, index) =>
  playEvents.recordPlayEvent(userId, {
    trackId: `track:${artist}:${index}`,
    title: `Song ${index}`,
    artist,
    playedAt: 1700000000 + index,
    source: "native-player",
  });

test.before(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
  process.env.LASTFM_API_KEY = "test-key";
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify(lastfmResponse(String(url))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  db.prepare(
    `INSERT INTO library_artists (identity_key, mbid, name, created_at, updated_at)
     VALUES ('library-one', ?, ?, 1, 1)`,
  ).run(LIBRARY.mbid, LIBRARY.name);
  alice = userOps.createUser("alice", "hash");
  bob = userOps.createUser("bob", "hash");
  discovery.addDiscoveryFeedback(alice.id, {
    artistId: LIKED.mbid,
    artistName: LIKED.name,
    action: "more_like_this",
  });
  discovery.addDiscoveryFeedback(alice.id, { artistName: "Disliked Artist", action: "less_like_this" });
  discovery.addDiscoveryFeedback(alice.id, {
    artistId: BLOCKED.mbid,
    artistName: BLOCKED.name,
    action: "block_artist",
  });
  play(alice.id, "Played Artist", 1);
  play(alice.id, "Disliked Artist", 2);
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  if (originalLastfmApiKey === undefined) delete process.env.LASTFM_API_KEY;
  else process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("personal refresh seeds from liked artists, local plays and the library, never disliked or blocked artists", async () => {
  const result = await discovery.updateUserDiscoveryCache(alice.id);
  assert.equal(result.refreshed, true);

  const { body } = await getUserDiscovery(alice.id, 0);
  assert.deepEqual(
    body.basedOn.map((artist) => artist.name).sort(),
    [LIBRARY.name, LIKED.name, "Played Artist"].sort(),
  );
  assert.equal(body.basedOn.find((artist) => artist.name === LIKED.name).source, "feedback");
  assert.deepEqual(
    body.recommendations.map((artist) => artist.name).sort(),
    [FROM_LIBRARY.name, FROM_LIKED.name, FROM_PLAYED.name].sort(),
  );
  assert.deepEqual([...body.topGenres].sort(), ["dream pop", "indie", "shoegaze"]);
  for (const artist of body.recommendations) {
    assert.equal(artist.tags.includes("female vocalists"), false);
    assert.equal(artist.tags.includes("seen live"), false);
  }
  assert.equal(body.isUpdating, false);
});

test("new feedback softens and hides served picks before the next refresh", async () => {
  const scoreOf = (recommendations) =>
    recommendations.find((artist) => artist.name === FROM_PLAYED.name).scoreTotal;
  const before = (await getUserDiscovery(alice.id, 0)).body.recommendations;
  const lessLike = discovery.addDiscoveryFeedback(alice.id, {
    artistId: FROM_PLAYED.mbid,
    artistName: FROM_PLAYED.name,
    action: "less_like_this",
  });
  const softened = (await getUserDiscovery(alice.id, 0)).body.recommendations;
  assert.equal(softened.length, before.length);
  assert.ok(scoreOf(softened) < scoreOf(before));

  discovery.addDiscoveryFeedback(alice.id, {
    artistId: FROM_LIBRARY.mbid,
    artistName: FROM_LIBRARY.name,
    action: "block_artist",
  });
  const blocked = (await getUserDiscovery(alice.id, 0)).body.recommendations.map((artist) => artist.name);
  assert.equal(blocked.includes(FROM_LIBRARY.name), false);
  discovery.removeDiscoveryFeedback(alice.id, lessLike.id);
});

const requestApi = async (userId, mountPath, router, path, init = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId, role: "user" };
    next();
  });
  app.use(mountPath, router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await originalFetch(
      `http://127.0.0.1:${server.address().port}${mountPath}${path}`,
      { ...init, headers: { "content-type": "application/json" } },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const requestDiscoveryApi = (userId, path, init) =>
  requestApi(userId, "/api/discover", discoveryRouter, path, init);

test("tag search and flow plans read the user's own pool", async () => {
  const tagged = await requestDiscoveryApi(alice.id, "/by-tag?tag=shoegaze");
  assert.equal(tagged.status, 200);
  assert.ok(tagged.body.recommendations.some((artist) => artist.name === FROM_LIKED.name));

  const source = new WeeklyFlowPlaylistSource();
  let basedOn = [];
  source.getReleaseRadarTracks = async (_limit, options) => {
    basedOn = options.basedOn;
    return [];
  };
  await source.buildFlowRunPlan({ ownerUserId: alice.id, discoverPresetId: "release-radar", size: 2 });
  assert.ok(basedOn.some((artist) => artist.name === LIKED.name));
});

test("tag search lists the tag's artists in Last.fm order without the user's recommendations", async () => {
  const { status, body } = await requestApi(
    alice.id,
    "/api/search",
    searchRouter,
    "?scope=tag&q=%23shoegaze",
  );
  assert.equal(status, 200);
  assert.deepEqual(
    body.items.map((artist) => artist.name),
    SHOEGAZE_TOP_ARTISTS.map((artist) => artist.name),
  );
  assert.equal(body.hasMore, false);
});

test("discover API shows a match percent that follows the user's ranking, not on trending", async () => {
  discovery.getDiscoveryCache().globalTop = [{ id: mbid(90), navigateTo: mbid(90), name: "Trending Artist" }];
  try {
    const { status, body } = await requestDiscoveryApi(alice.id, "");
    assert.equal(status, 200);
    const percents = body.recommendations.map((artist) => artist.matchPercent);
    assert.ok(percents.length >= 2);
    assert.equal(percents[0], 99);
    assert.equal(percents.at(-1), 55);
    assert.deepEqual([...percents].sort((left, right) => right - left), percents);
    assert.equal(body.globalTop[0].name, "Trending Artist");
    assert.equal(body.globalTop[0].matchPercent, null);
  } finally {
    discovery.getDiscoveryCache().globalTop = [];
  }
});

test("feedback through the API waits for the next scheduled rebuild", async () => {
  const response = await requestDiscoveryApi(alice.id, "/feedback", {
    method: "POST",
    body: JSON.stringify({ artistName: "Another Favorite", action: "more_like_this" }),
  });
  assert.equal(response.status, 200);

  const queuedForAlice = db.prepare(
    "SELECT payload FROM _honker_live WHERE queue = 'discovery-user-refresh'",
  ).all().filter((row) => JSON.parse(row.payload).userId === alice.id);
  assert.equal(queuedForAlice.length, 0);
  assert.ok(
    discovery.getDiscoveryFeedback(alice.id).some((entry) => entry.artistName === "Another Favorite"),
  );
});

test("each user gets their own pool and a missing pool queues one refresh", async () => {
  const { body } = await getUserDiscovery(bob.id, 0);
  assert.equal(body.recommendations.some((artist) => artist.name === FROM_LIKED.name), false);
  assert.equal(body.isUpdating, true);
  assert.equal(body.updatePhase, "personalizing");

  assert.deepEqual(
    discovery.requestUserDiscoveryRefresh(bob.id),
    { enqueued: false, reason: "queued" },
  );
  const queued = db.prepare(
    "SELECT payload FROM _honker_live WHERE queue = 'discovery-user-refresh'",
  ).all().map((row) => JSON.parse(row.payload));
  assert.deepEqual(queued.map((payload) => payload.userId), [bob.id]);
});

test("library seeds sample recent additions and the whole library, not the alphabetical head", () => {
  const insert = db.prepare(
    `INSERT INTO library_artists (identity_key, name, sort_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < 100; index += 1) {
    const name = `Artist ${String(index).padStart(3, "0")}`;
    insert.run(`sample-${index}`, name, name, 10 + index, 10 + index);
  }
  insert.run("sample-newest", "Zed Newest", "Zed Newest", 1000, 1000);

  const alphabeticalHead = new Set(
    db.prepare("SELECT name FROM library_artists ORDER BY sort_name COLLATE NOCASE LIMIT 40").all()
      .map((row) => row.name),
  );
  const samples = Array.from({ length: 5 }, () =>
    sampleLibraryArtistsForDiscovery({ recentLimit: 5, randomLimit: 20 }));

  for (const { recent, random } of samples) {
    assert.equal(recent[0].artistName, "Zed Newest");
    const recentNames = new Set(recent.map((artist) => artist.artistName));
    assert.equal(random.some((artist) => recentNames.has(artist.artistName)), false);
  }
  assert.ok(
    samples.some(({ random }) => random.some((artist) => !alphabeticalHead.has(artist.artistName))),
  );
});
