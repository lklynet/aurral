import { testUser } from "../helpers/userFixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import * as v from "valibot";
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
  { getArtistTagLists, getSimilarArtists },
] = await setupIsolatedBackend(
  "listenbrainz-discovery",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/discovery/index.ts"),
  () => import("../../backend/services/discovery/userDiscovery.ts"),
  () => import("../../backend/routes/search.ts"),
  () => import("../../backend/routes/artists/handlers/similar.ts"),
  () => import("../../backend/services/flows/flowTrackSource.ts"),
  () => import("../../backend/services/musicDataSource/index.ts"),
);

const mbid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const LIKED = { name: "Liked Artist", mbid: mbid(1) };
const LIBRARY = { name: "Library One", mbid: mbid(2) };
const QUIET = { name: "Quiet Artist", mbid: mbid(3) };
const FLOW_SEED = { name: "Flow Seed", mbid: mbid(6) };
const NEIGHBOR = { name: "Neighbor Artist", mbid: mbid(4) };
const TAGGED = { name: "Tagged Artist", mbid: mbid(5) };
const RELATED = { name: "Related Pick", mbid: mbid(31) };
const SIMILAR_SEED = { name: "Static Similar Seed", mbid: mbid(7) };
const SIMILAR_PICK = {
  name: "Static Similar Pick",
  mbid: mbid(41),
  image: "https://images.example/similar-pick.jpg",
};
const GENRE_PICK = {
  name: "Electronic Pioneer",
  mbid: mbid(42),
  image: "https://images.example/electronic-pioneer.jpg",
};
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
  [
    NEIGHBOR.mbid,
    [
      { ...CLOSE_PICK, score: 900 },
      { ...SHARED_PICK, score: 450 },
    ],
  ],
]);

const originalFetch = globalThis.fetch;
let requests: URL[] = [];
let alice: NonNullable<ReturnType<typeof userOps.createUser>>;

const json = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const respond = (url: URL) => {
  if (url.hostname === "data.aurral.org" && url.pathname.startsWith("/v1/artist/")) {
    const seed = url.pathname.slice("/v1/artist/".length);
    if (seed === QUIET.mbid) {
      return json({ id: QUIET.mbid, name: QUIET.name, links: [], albums: [] });
    }
    if (seed === SIMILAR_SEED.mbid) {
      return json({
        id: SIMILAR_SEED.mbid,
        name: SIMILAR_SEED.name,
        links: [],
        albums: [],
        similar: [
          {
            id: SIMILAR_PICK.mbid,
            name: SIMILAR_PICK.name,
            score: 1.4,
            image: SIMILAR_PICK.image,
            genres: ["Slowcore"],
          },
        ],
      });
    }
    if (seed === TAGGED.mbid) {
      return json({
        id: TAGGED.mbid,
        name: TAGGED.name,
        genres: ["Shoegaze", "Dream Pop"],
        links: [],
        albums: [],
      });
    }
    const similar = similarBySeed.get(seed);
    if (similar) {
      return json({
        id: seed,
        name:
          seed === LIKED.mbid ? LIKED.name : seed === LIBRARY.mbid ? LIBRARY.name : NEIGHBOR.name,
        genres: seed === LIKED.mbid ? ["seen live"] : ["seen live", "Shoegaze", "Dream Pop"],
        links: [],
        albums: [],
        similar: similar.map((artist) => ({
          id: artist.mbid,
          name: artist.name,
          score: artist.score / 500,
          image: null,
        })),
      });
    }
    return json({
      id: seed,
      name: "Candidate Artist",
      genres: ["seen live", "Shoegaze", "Dream Pop"],
      links: [],
      albums: [],
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
    if (url.searchParams.get("q") === FLOW_SEED.name)
      return json({ data: [{ id: 10, name: FLOW_SEED.name }] });
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
  if (url.hostname === "api.deezer.com" && url.pathname === "/artist/10/related") {
    return json({ data: [{ id: 41, name: "Flow Pick" }] });
  }
  if (url.hostname === "data.aurral.org" && url.pathname === "/v1/genre/electronic") {
    return json({
      name: "Electronic",
      artists: [
        { id: GENRE_PICK.mbid, name: GENRE_PICK.name, image: GENRE_PICK.image, listeners: 40000 },
      ],
    });
  }
  if (url.hostname === "data.aurral.org" && url.pathname === "/v1/search/artist") {
    const found = [RELATED, SIMILAR_SEED].find(
      (artist) => artist.name === url.searchParams.get("q"),
    );
    return json({ artists: found ? [{ id: found.mbid, name: found.name }] : [] });
  }
  if (url.hostname === "api.deezer.com" && url.pathname === "/artist/7/top") {
    return json({
      data: [
        { id: 70, title: "Hit Song", album: { title: "First Album" }, duration: 200, rank: 5000 },
      ],
    });
  }
  return json({ error: "unexpected" }, 404);
};

beforeAll(() => {
  resetDatabase(db);
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
  await cleanupIsolatedState(isolatedState);
});

test("each user gets personal recommendations from ListenBrainz", async () => {
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
  assert.equal(body.recommendations[0]?.seedCount, 2);
  assert.deepEqual([...body.topGenres].sort(), ["dream pop", "shoegaze"]);
  assert.equal(
    body.recommendations.some((artist) => artist.tags?.includes("seen live")),
    false,
  );
  assert.equal(
    requests.some((url) => url.hostname === "ws.audioscrobbler.com"),
    false,
  );
  const likedArtistLookups = requests.filter(
    (url) => url.hostname === "data.aurral.org" && url.pathname === `/v1/artist/${LIKED.mbid}`,
  );
  assert.equal(likedArtistLookups.length, 1);
  assert.equal(
    requests.some((url) => url.pathname === "/1/metadata/artist/"),
    false,
  );
});

const searchBodySchema = v.looseObject({
  items: v.array(
    v.looseObject({
      id: v.optional(v.nullable(v.string())),
      name: v.string(),
      image: v.optional(v.nullable(v.string())),
    }),
  ),
  hasMore: v.optional(v.boolean()),
});

const similarBodySchema = v.object({
  artists: v.array(
    v.looseObject({
      id: v.string(),
      name: v.string(),
      image: v.optional(v.nullable(v.string())),
      match: v.optional(v.number()),
    }),
  ),
});

const requestSearch = async (query: string) => {
  const response = await signedInAs(testUser(alice.id))
    .route("/", search)
    .request(`/search${query}`);
  return { status: response.status, body: v.parse(searchBodySchema, await response.json()) };
};

test("tag search lists MusicBrainz's artists for the tag", async () => {
  const { status, body } = await requestSearch("?scope=tag&q=%23shoegaze");

  assert.equal(status, 200);
  assert.deepEqual(
    body.items.map((artist) => artist.name),
    ["Shoegaze Leader", "Shoegaze Second"],
  );
  assert.equal(body.hasMore, false);
  const search = requests.find((url) => url.hostname === "musicbrainz.org");
  assert.ok(search != null);
  assert.equal(search.searchParams.get("query"), 'tag:"shoegaze"');
});

test("artist tags come from cached v1 artist metadata and refresh in the background after a week", async () => {
  const loadTags = async () =>
    (await getArtistTagLists([TAGGED]))[0]?.map((tag: { name: string }) => tag.name);
  const lookups = () =>
    requests.filter(
      (url) => url.hostname === "data.aurral.org" && url.pathname === `/v1/artist/${TAGGED.mbid}`,
    ).length;
  const expected = ["shoegaze", "dream pop"];

  assert.deepEqual(await loadTags(), expected);
  assert.deepEqual(await loadTags(), expected);
  assert.equal(lookups(), 1);

  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await loadTags(), expected);
  await vi.runAllTimersAsync();
  assert.equal(lookups(), 2);

  await getSimilarArtists(SIMILAR_SEED);
  requests = [];
  assert.deepEqual(await getArtistTagLists([{ mbid: SIMILAR_PICK.mbid }, { mbid: mbid(43) }]), [
    [{ name: "slowcore", count: 100 }],
    ["seen live", "shoegaze", "dream pop"].map((name) => ({ name, count: 100 })),
  ]);
  assert.deepEqual(
    requests.map((url) => url.pathname),
    [`/v1/artist/${mbid(43)}`],
  );
});

test("artist pages list Deezer's related artists that MusicBrainz knows", async () => {
  const response = await similar.request(
    `/artists/${QUIET.mbid}/similar?${new URLSearchParams({ artistName: QUIET.name })}`,
  );
  const body = v.parse(similarBodySchema, await response.json());

  assert.deepEqual(
    body.artists.map((artist) => [artist.id, artist.name]),
    [[RELATED.mbid, RELATED.name]],
  );
  assert.ok(body.artists[0]?.image);
});

test("flows that only know an artist's MBID still get Deezer's related artists", async () => {
  const artists = await new FlowTrackSource()._getSimilarArtists(QUIET.mbid);

  assert.deepEqual(
    artists.map((artist) => artist.name),
    [RELATED.name, "Unknown To MusicBrainz"],
  );
});

test("flows take Deezer's related artists by name without looking each one up", async () => {
  const artists = await new FlowTrackSource()._getSimilarArtists(FLOW_SEED.name);

  assert.deepEqual(
    artists.map((artist) => [artist.mbid, artist.name]),
    [[null, "Flow Pick"]],
  );
  assert.equal(
    requests.some((url) => url.hostname === "data.aurral.org"),
    false,
  );
});

test("a seed known only by name takes its similar list from the ID its genres lookup found", async () => {
  await getArtistTagLists([{ name: SIMILAR_SEED.name }]);
  requests = [];

  const artists = await getSimilarArtists({ name: SIMILAR_SEED.name });

  assert.deepEqual(
    artists.map((artist) => [artist.mbid, artist.name]),
    [[SIMILAR_PICK.mbid, SIMILAR_PICK.name]],
  );
  assert.deepEqual(requests, []);
});

test("artist pages and genre search use v1 static similar artists and genre lists before falling back", async () => {
  const similarResponse = await similar.request(
    `/artists/${SIMILAR_SEED.mbid}/similar?${new URLSearchParams({ artistName: SIMILAR_SEED.name })}`,
  );
  const similarBody = v.parse(similarBodySchema, await similarResponse.json());
  assert.deepEqual(
    similarBody.artists.map((artist) => [artist.id, artist.name, artist.image]),
    [[SIMILAR_PICK.mbid, SIMILAR_PICK.name, SIMILAR_PICK.image]],
  );
  assert.ok(
    similarBody.artists[0]!.match !== undefined &&
      similarBody.artists[0]!.match > 50 &&
      similarBody.artists[0]!.match <= 100,
  );
  assert.equal(
    requests.some(
      (url) => url.hostname === "api.deezer.com" || url.hostname.endsWith("listenbrainz.org"),
    ),
    false,
  );

  requests = [];
  const genreSearch = await requestSearch("?scope=tag&q=%23electronic");
  assert.equal(genreSearch.status, 200);
  assert.deepEqual(
    genreSearch.body.items.map((artist) => [artist.id, artist.name, artist.image]),
    [[GENRE_PICK.mbid, GENRE_PICK.name, GENRE_PICK.image]],
  );
  assert.equal(
    requests.some((url) => url.hostname === "musicbrainz.org"),
    false,
  );
});

test("a Mix flow picks the library artist's own Deezer top track", async () => {
  const plan = await new FlowTrackSource().buildFlowRunPlan({
    size: 1,
    mix: { mix: 100 },
  });

  assert.deepEqual(
    plan.primaryTracks.map((track) => [
      track.reason,
      track.artistName,
      track.trackName,
      track.albumName,
    ]),
    [["In your Library", LIBRARY.name, "Hit Song", "First Album"]],
  );
  assert.equal(
    requests.some((url) => url.pathname === "/artist/8/top"),
    false,
  );
});
