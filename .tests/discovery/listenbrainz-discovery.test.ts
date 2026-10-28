import { testUser } from "../helpers/userFixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  discovery,
  { getUserDiscovery },
  { default: search },
  { default: similar },
  { FlowTrackSource },
] = await setupIsolatedBackend(
  "listenbrainz-discovery",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/discovery/index.ts"),
  () => import("../../backend/services/discovery/userDiscovery.ts"),
  () => import("../../backend/routes/search.ts"),
  () => import("../../backend/routes/artists/handlers/similar.ts"),
  () => import("../../backend/services/flows/flowTrackSource.ts"),
);

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const LIKED = { name: "Liked Artist", mbid: mbid(1) };
const LIBRARY = { name: "Library One", mbid: mbid(2) };
const QUIET = { name: "Quiet Artist", mbid: mbid(3) };
const RELATED = { name: "Related Pick", mbid: mbid(31) };
const RELATED_PHOTO = "https://cdn-images.dzcdn.net/images/artist/related/1000x1000.jpg";
const CLOSE_PICK = { name: "Close Pick", mbid: mbid(11) };
const SHARED_PICK = { name: "Shared Pick", mbid: mbid(12) };
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

const similarBySeed = new Map([
  [
    LIKED.mbid,
    [
      { ...CLOSE_PICK, score: 900 },
      { ...SHARED_PICK, score: 450 },
      { ...LIBRARY, score: 300 },
    ],
  ],
  [LIBRARY.mbid, [{ ...SHARED_PICK, score: 800 }]],
]);

const originalFetch = globalThis.fetch;
const originalLastfmApiKey = process.env.LASTFM_API_KEY;
let requests: URL[] = [];
let alice: NonNullable<ReturnType<typeof userOps.createUser>>;

const json = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const respond = (url: URL) => {
  if (url.hostname === "labs.api.listenbrainz.org" && url.pathname === "/similar-artists/json") {
    const seed = url.searchParams.get("artist_mbids");
    assert.ok(seed != null);
    return json(
      (similarBySeed.get(seed) || []).map((artist) => ({
        artist_mbid: artist.mbid,
        name: artist.name,
        score: artist.score,
        reference_mbid: seed,
      })),
    );
  }
  if (url.hostname === "api.listenbrainz.org" && url.pathname === "/1/metadata/artist/") {
    return json(
      url.searchParams
        .get("artist_mbids")!
        .split(",")
        .map((artistMbid) => ({
          artist_mbid: artistMbid,
          tag: {
            artist:
              artistMbid === LIKED.mbid
                ? [{ tag: "seen live", count: 9 }]
                : [
                    { tag: "seen live", count: 9 },
                    { tag: "shoegaze", count: 4 },
                    { tag: "dream pop", count: 2 },
                  ],
          },
        })),
    );
  }
  if (url.hostname === "api.listenbrainz.org" && url.pathname === "/1/stats/sitewide/recordings") {
    return json({
      payload: {
        recordings: Array.from({ length: 60 }, (_, index) => ({
          artist_name: `Chart Artist ${index}`,
          artist_mbids: [mbid(100 + index)],
          track_name: `Chart Song ${index}`,
          release_name: `Chart Album ${index}`,
        })),
      },
    });
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
    if (url.searchParams.get("q") === QUIET.name)
      return json({ data: [{ id: 9, name: QUIET.name }] });
    return json({
      data: [
        { id: 8, name: "Library Onesie" },
        { id: 7, name: "Library One" },
      ],
    });
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/artist/9/related") {
    return json({
      data: [
        { id: 31, name: RELATED.name, picture_xl: RELATED_PHOTO },
        { id: 32, name: "Unknown To MusicBrainz" },
      ],
    });
  }
  if (url.hostname === "lidarrapi.brainzmash.cc" && url.pathname === `/artist/${QUIET.mbid}`) {
    return json({ id: QUIET.mbid, artistname: QUIET.name, links: [], Albums: [] });
  }
  if (url.hostname === "lidarrapi.brainzmash.cc" && url.pathname === "/search/artist") {
    return json(
      url.searchParams.get("query") === RELATED.name
        ? [{ id: RELATED.mbid, artistname: RELATED.name }]
        : [],
    );
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/artist/7/top") {
    return json({
      data: [{ title: "Hit Song", album: { title: "First Album" }, duration: 200, rank: 5000 }],
    });
  }
  return json({ error: "unexpected" }, 404);
};

beforeAll(() => {
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
  const created = userOps.createUser("alice", "hash");
  assert.ok(created);
  alice = created;
  discovery.addDiscoveryFeedback(alice.id, {
    artistId: LIKED.mbid,
    artistName: LIKED.name,
    action: "more_like_this",
  });
});

beforeEach(() => {
  requests = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalLastfmApiKey !== undefined) process.env.LASTFM_API_KEY = originalLastfmApiKey;
  await cleanupIsolatedState(isolatedState);
});

test("without a Last.fm key each user gets personal recommendations from ListenBrainz", async () => {
  assert.deepEqual(await discovery.updateUserDiscoveryCache(alice.id), {
    refreshed: true,
    recommendationCount: 2,
  });

  const { body } = await getUserDiscovery(alice.id, 0);
  assert.equal(body.provider, "listenbrainz");
  assert.deepEqual(
    body.basedOn.map((artist) => artist.name).sort(),
    [LIBRARY.name, LIKED.name].sort(),
  );
  assert.deepEqual(
    body.recommendations.map((artist) => artist.name),
    [SHARED_PICK.name, CLOSE_PICK.name],
  );
  assert.equal(body.recommendations[0].seedCount, 2);
  assert.deepEqual([...body.topGenres].sort(), ["dream pop", "shoegaze"]);
  assert.equal(
    body.recommendations.some((artist) => artist.tags?.includes("seen live")),
    false,
  );
  assert.equal(
    requests.some((url) => url.hostname === "ws.audioscrobbler.com"),
    false,
  );
  const likedTagLookups = requests.filter(
    (url) =>
      url.pathname === "/1/metadata/artist/" &&
      url.searchParams.get("artist_mbids")!.split(",").includes(LIKED.mbid),
  );
  assert.equal(likedTagLookups.length, 1);
});

const requestSearch = async (query: string) => {
  const response = await signedInAs(testUser(alice.id))
    .route("/", search)
    .request(`/search${query}`);
  return { status: response.status, body: await response.json() };
};

test("without a Last.fm key tag search lists MusicBrainz's artists for the tag", async () => {
  const { status, body } = await requestSearch("?scope=tag&q=%23shoegaze");

  assert.equal(status, 200);
  assert.deepEqual(
    body.items.map((artist: { name: string }) => artist.name),
    ["Shoegaze Leader", "Shoegaze Second"],
  );
  assert.equal(body.hasMore, false);
  const search = requests.find((url) => url.hostname === "musicbrainz.org");
  assert.ok(search != null);
  assert.equal(search.searchParams.get("query"), 'tag:"shoegaze"');
});

test("without a Last.fm key artist pages list ListenBrainz similar artists", async () => {
  const response = await similar.request(
    `/artists/${LIKED.mbid}/similar?${new URLSearchParams({ artistName: LIKED.name })}`,
  );
  const body: { artists: { name: string; match: number }[] } = await response.json();

  assert.deepEqual(
    body.artists.map((artist) => [artist.name, artist.match]),
    [
      [CLOSE_PICK.name, 100],
      [SHARED_PICK.name, 50],
      [LIBRARY.name, 33],
    ],
  );
});

test("without a Last.fm key artist pages fall back to Deezer's related artists when ListenBrainz has none", async () => {
  const response = await similar.request(
    `/artists/${QUIET.mbid}/similar?${new URLSearchParams({ artistName: QUIET.name })}`,
  );
  const body: { artists: { id: string; name: string; image: string | null }[] } =
    await response.json();

  assert.deepEqual(
    body.artists.map((artist) => [artist.id, artist.name]),
    [[RELATED.mbid, RELATED.name]],
  );
  assert.ok(body.artists[0].image);
});

test("flows that only know an artist's MBID still get Deezer's related artists", async () => {
  const artists = await new FlowTrackSource()._getSimilarArtists(QUIET.mbid);

  assert.deepEqual(
    artists.map((artist) => [artist.mbid, artist.name]),
    [
      [RELATED.mbid, RELATED.name],
      [null, "Unknown To MusicBrainz"],
    ],
  );
});

test("without a Last.fm key a Mix flow picks the library artist's own Deezer top track", async () => {
  const plan = await new FlowTrackSource().buildFlowRunPlan({
    size: 1,
    mix: { discover: 0, mix: 100, trending: 0, focus: 0 },
  });

  assert.deepEqual(
    plan.primaryTracks.map((track) => [
      "source" in track ? track.source : undefined,
      track.artistName,
      track.trackName,
      track.albumName,
    ]),
    [["mix", LIBRARY.name, "Hit Song", "First Album"]],
  );
  assert.equal(
    requests.some((url) => url.pathname === "/artist/8/top"),
    false,
  );
});

test("without a Last.fm key flows of any size share one ListenBrainz trending request", async () => {
  const source = new FlowTrackSource();
  const small = await source.getTrendingTracks(5);
  const large = await source.getTrendingTracks(40);

  assert.equal(small.length, 5);
  assert.equal(large.length, 40);
  assert.equal(requests.filter((url) => url.pathname === "/1/stats/sitewide/recordings").length, 1);
});

test("switching sources never keeps the other source's trending artists when ListenBrainz fails", async () => {
  Object.assign(discovery.getDiscoveryCache(), {
    provider: "lastfm",
    globalTop: [
      { id: mbid(90), name: "Last.fm Chart Artist", popularityLabel: "1M listeners on Last.fm" },
    ],
  });

  await discovery.updateDiscoveryCache();

  const cache = dbOps.getDiscoveryCache();
  assert.equal(cache.provider, "listenbrainz");
  assert.deepEqual([...cache.globalTop], []);
  assert.ok(requests.some((url) => url.pathname === "/1/stats/sitewide/artists"));
});
