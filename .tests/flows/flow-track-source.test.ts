import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { FlowTrackSource } from "../../backend/services/flows/flowTrackSource.ts";

type DeezerArtist = {
  id: number;
  name: string;
  albums: { id: number; title: string; release_date: string; record_type?: string }[];
  albumTracks?: Record<number, { id: number; title: string; rank: number; duration: number }[]>;
};

const deezerArtists = new Map<string, DeezerArtist>();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const respond = (url: URL) => {
  if (url.pathname === "/search/artist") {
    const artist = deezerArtists.get(url.searchParams.get("q") ?? "");
    return json({ data: artist ? [{ id: artist.id, name: artist.name }] : [] });
  }
  const artist = [...deezerArtists.values()].find(
    (entry) => url.pathname === `/artist/${entry.id}/albums`,
  );
  if (artist) {
    return json({
      data: artist.albums.map((album) => ({ record_type: "album", ...album })),
    });
  }
  const albumId = Number(url.pathname.match(/^\/album\/(\d+)\/tracks$/)?.[1]);
  const tracks = [...deezerArtists.values()].find((entry) => entry.albumTracks?.[albumId])
    ?.albumTracks?.[albumId];
  return json(tracks ? { data: tracks } : { error: { code: 800 } });
};

beforeEach(() => {
  deezerArtists.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    respond(new URL(String(input))),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const candidate = (source: FlowTrackSource, artistName: string) => {
  const track = source._buildTrackEntry({ artistName, trackName: `${artistName} Song` });
  assert.ok(track);
  return track;
};

const topTrack = (
  name: string,
  albumName: string,
): Awaited<ReturnType<FlowTrackSource["_getArtistTopTrackList"]>>[number] => ({
  name,
  albumName,
  mbid: null,
  durationMs: null,
  popularity: 0,
});

const years = (source: FlowTrackSource, yearFrom: number, yearTo: number) => ({
  ...source._buildFilters({}, new Set()),
  yearFrom,
  yearTo,
});

test("year range matching accepts bounds and rejects unknown years when set", () => {
  const source = new FlowTrackSource();
  assert.equal(source._matchesYearRange("1985", null, null), true);
  assert.equal(source._matchesYearRange("1985", 1980, 1989), true);
  assert.equal(source._matchesYearRange("1979", 1980, 1989), false);
  assert.equal(source._matchesYearRange("1990", 1980, 1989), false);
  assert.equal(source._matchesYearRange("2024", 2020, null), true);
  assert.equal(source._matchesYearRange("2019", 2020, null), false);
  assert.equal(source._matchesYearRange(null, 2020, 2026), false);
  assert.equal(source._matchesYearRange(null, null, 2000), false);
  assert.equal(source._matchesYearRange(null, null, null), true);
});

test("a plan fills each source's share, then backfills without repeating an artist", () => {
  const source = new FlowTrackSource();
  const plan = source._assembleFlowPlan({
    candidateMap: {
      discover: [candidate(source, "Shared"), candidate(source, "Discover")],
      mix: [candidate(source, "Shared")],
      trending: [],
      focus: [],
      newReleases: [],
    },
    excludeArtistKeys: new Set(),
    targetSize: 3,
    sourceTargets: { discover: 1, mix: 1, trending: 1, focus: 0, newReleases: 0 },
  });
  assert.deepEqual(
    plan.primaryTracks.map((track) => track.artistName),
    ["Shared", "Discover"],
  );
});

test("a source can fill the whole flow when another source comes up empty", async () => {
  const source = new FlowTrackSource();
  source._getLibraryArtistKeySet = async () => new Set<string>();
  source.getMixTracks = async () => [];
  source.getDiscoverTracks = async (limit) =>
    Array.from({ length: Math.min(limit, 40) }, (_, index) => candidate(source, `Artist ${index}`));

  const plan = await source.buildFlowRunPlan({ size: 30, mix: { discover: 1, mix: 29 } });

  assert.equal(plan.primaryTracks.length, 30);
});

test("Library can fill a large flow on its own", async () => {
  const source = new FlowTrackSource();
  source._getLibraryArtists = () =>
    Array.from({ length: 120 }, (_, index) => ({ id: index + 1, name: `Owned ${index}` }));
  source._getLibraryOwnership = async () => ({ ownedTitles: new Set(), ownedAlbums: new Set() });
  source._pickTrack = async (name) => ({ trackName: `${name} Song` });

  const tracks = await source.getMixTracks(100);

  assert.equal(tracks.length, 100);
});

test("a year range picks a popular track from a release first out in that range", async () => {
  deezerArtists.set("Year Band", {
    id: 101,
    name: "Year Band",
    albums: [
      { id: 1011, title: "Old Album", release_date: "2019-05-01" },
      { id: 1012, title: "Old Album (Remastered)", release_date: "2025-02-01" },
      { id: 1013, title: "New Album", release_date: "2025-09-01" },
    ],
  });
  const source = new FlowTrackSource();
  source._getArtistTopTrackList = async () => [
    topTrack("Old Hit", "Old Album (Remastered)"),
    topTrack("New Hit", "New Album"),
  ];

  const pick = await source._pickTrackInYears("Year Band", years(source, 2025, 2026), false);

  assert.equal(pick?.trackName, "New Hit");
  assert.equal(pick?.releaseYear, "2025");
});

test("a year range falls back to the best track of an in-range release", async () => {
  deezerArtists.set("Deep Band", {
    id: 102,
    name: "Deep Band",
    albums: [
      { id: 1021, title: "Classic", release_date: "2001-01-01" },
      { id: 1022, title: "Comeback", release_date: "2026-03-01" },
    ],
    albumTracks: {
      1022: [
        { id: 1, title: "Intro", rank: 10, duration: 60 },
        { id: 2, title: "Single", rank: 900, duration: 200 },
        { id: 3, title: "Outro", rank: 40, duration: 90 },
      ],
    },
  });
  const source = new FlowTrackSource();
  source._getArtistTopTrackList = async () => [topTrack("Classic Hit", "Classic")];

  const pick = await source._pickTrackInYears("Deep Band", years(source, 2025, 2026), false);

  assert.equal(pick?.trackName, "Single");
  assert.equal(pick?.albumName, "Comeback");
  assert.equal(pick?.durationMs, 200000);
});

test("tags filter trending artists and match spelling variants", async () => {
  const source = new FlowTrackSource();
  const chartTrack = (artistName: string) => ({
    artistName,
    artistMbid: null,
    name: `${artistName} Song`,
    albumName: null,
  });
  source._getTrendingChart = async () => [chartTrack("Pop Star"), chartTrack("Rapper")];
  source._getArtistTopTagLists = async (artists) =>
    artists.map((artist) => (artist.name === "Rapper" ? ["Hip-Hop"] : ["pop"]));

  const tracks = await source.getTrendingTracks(2, {
    filters: source._buildFilters({ tags: ["hip hop"] }, new Set()),
  });

  assert.deepEqual(
    tracks.map((track) => [track.artistName, track.reason]),
    [["Rapper", "Trending this week"]],
  );
});

test("discover takes its picks from the top of the ranking and says why", async () => {
  const source = new FlowTrackSource();
  source._getRecommendations = () => [
    { name: "First", matchPercent: 90, supportingSeeds: [{ artistName: "Seed One" }] },
    { name: "Second", matchPercent: 80, sourceArtists: ["Seed Two"] },
    { name: "Third", matchPercent: 70 },
    { name: "Fourth", matchPercent: 60 },
  ];
  source._getArtistTopTrackList = async (name) => [topTrack(`${name} Song`, `${name} Album`)];

  const tracks = await source.getDiscoverTracks(2);

  assert.deepEqual(tracks.map((track) => [track.artistName, track.reason]).sort(), [
    ["First", "Similar to Seed One"],
    ["Second", "Similar to Seed Two"],
  ]);
});

test("discover filters by an artist's own tags, not tags borrowed from its seeds", async () => {
  const source = new FlowTrackSource();
  const looked: (string | null | undefined)[] = [];
  source._getRecommendations = () => [
    {
      name: "Pop Act",
      matchPercent: 90,
      tags: ["hip hop"],
      candidateTagsHydrated: true,
      tagSource: "inherited",
    },
    {
      name: "Rapper",
      matchPercent: 80,
      tags: ["Hip-Hop"],
      candidateTagsHydrated: true,
      tagSource: "lastfm_artist",
    },
  ];
  source._getArtistTopTagLists = async (artists) => {
    looked.push(...artists.map((artist) => artist.name));
    return artists.map(() => ["pop"]);
  };
  source._getArtistTopTrackList = async (name) => [topTrack(`${name} Song`, `${name} Album`)];

  const tracks = await source.getDiscoverTracks(2, {
    filters: source._buildFilters({ tags: ["hip hop"] }, new Set()),
  });

  assert.deepEqual(looked, ["Pop Act"]);
  assert.deepEqual(
    tracks.map((track) => track.artistName),
    ["Rapper"],
  );
});

test("discover skips an artist whose own tags include a blocked genre", async () => {
  const source = new FlowTrackSource();
  source._getRecommendations = () => [
    {
      name: "Country Rapper",
      matchPercent: 90,
      tags: ["country", "rap"],
      candidateTagsHydrated: true,
    },
    { name: "Rapper", matchPercent: 80, tags: ["rap"], candidateTagsHydrated: true },
  ];
  source._getArtistTopTrackList = async (name) => [topTrack(`${name} Song`, `${name} Album`)];

  const tracks = await source.getDiscoverTracks(2, {
    filters: source._buildFilters({ tags: ["rap"] }, new Set()),
    blockedTags: new Set(["country"]),
  });

  assert.deepEqual(
    tracks.map((track) => track.artistName),
    ["Rapper"],
  );
});

test("a flow whose every tag is blocked does not fall back to unfiltered picks", async () => {
  const source = new FlowTrackSource();
  const blockedTags = new Set(["rap"]);
  source._getRecommendations = () => [
    { name: "Pop Act", matchPercent: 90, tags: ["pop"], candidateTagsHydrated: true },
    { name: "Rapper", matchPercent: 80, tags: ["rap"], candidateTagsHydrated: true },
  ];
  source._getArtistTopTrackList = async (name) => [topTrack(`${name} Song`, `${name} Album`)];

  const tracks = await source.getDiscoverTracks(2, {
    filters: source._buildFilters({ tags: ["rap"] }, blockedTags),
    blockedTags,
  });

  assert.deepEqual(tracks, []);
});

test("a year range tells apart releases with non-Latin titles", async () => {
  deezerArtists.set("Kanji Band", {
    id: 104,
    name: "Kanji Band",
    albums: [
      { id: 1041, title: "初恋", release_date: "2018-04-01" },
      { id: 1042, title: "新世界", release_date: "2025-08-01" },
    ],
  });
  const source = new FlowTrackSource();
  source._getArtistTopTrackList = async () => [
    topTrack("Old Hit", "初恋"),
    topTrack("New Hit", "新世界"),
  ];

  const pick = await source._pickTrackInYears("Kanji Band", years(source, 2025, 2026), false);

  assert.equal(pick?.trackName, "New Hit");
  assert.equal(pick?.releaseYear, "2025");
});

test("Deep Dive with a year range keeps preferring tracks ranked 10 to 25", async () => {
  deezerArtists.set("Dive Band", {
    id: 103,
    name: "Dive Band",
    albums: [
      { id: 1031, title: "Old Album", release_date: "2010-01-01" },
      { id: 1032, title: "New Album", release_date: "2025-06-01" },
    ],
  });
  const source = new FlowTrackSource();
  source._getArtistTopTrackList = async () =>
    Array.from({ length: 16 }, (_, rank) =>
      topTrack(`Track ${rank}`, rank === 0 || rank === 12 ? "New Album" : "Old Album"),
    );

  const pick = await source._pickTrackInYears("Dive Band", years(source, 2025, 2026), true);

  assert.equal(pick?.trackName, "Track 12");
});

test("new releases try an artist's older release when the newest has no usable track", async () => {
  const source = new FlowTrackSource();
  const release = (albumName: string, releaseDate: string) => ({
    artistName: "Band",
    artistMbid: null,
    foreignArtistId: null,
    releaseDate,
    albumName,
    mbid: "",
    foreignAlbumId: "",
  });
  source._getRecentReleases = async () => [
    release("Newest", "2026-03-01"),
    release("Older", "2026-01-01"),
  ];
  source._pickTrackFromRelease = async ({ albumTitle }) =>
    albumTitle === "Older" ? { trackName: "Older Single", albumName: "Older" } : null;

  const tracks = await source.getNewReleaseTracks(5);

  assert.deepEqual(
    tracks.map((track) => track.trackName),
    ["Older Single"],
  );
});

test("mix album pick prefers top track list metadata before track.getInfo", () => {
  const source = new FlowTrackSource();
  const ownedTitles = new Set(["owned track"]);
  const ownedAlbums = new Set(["owned album"]);
  const trackList = [topTrack("Owned Track", "Owned Album"), topTrack("Fresh Track", "New Album")];
  const picked = source._pickTrackFromRangesWithOwnedAlbumsUsingListMetadata(
    trackList,
    ownedTitles,
    ownedAlbums,
    [{ start: 0, end: 5 }],
  );
  assert.equal(picked?.pick?.name, "Fresh Track");
  assert.equal(picked?.albumName, "New Album");
});

test("new releases pick a release track from metadata before Last.fm fallbacks", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [
    {
      id: "track-id",
      title: "Opening Track",
      trackNumber: 1,
      trackPosition: 1,
      mediumNumber: 1,
      recordingId: "recording-mbid",
      oldRecordingIds: [],
      durationMs: 185000,
      artistId: null,
      releaseMbid: null,
    },
  ];
  source._getLastfmAlbumInfo = async () => {
    throw new Error("Last.fm should not be needed");
  };

  const track = await source._pickTrackFromRelease({
    artistName: "Library Artist",
    albumTitle: "New Album",
    albumMbid: "album-mbid",
    releaseYear: "2026",
  });

  assert.equal(track?.trackName, "Opening Track");
  assert.equal(track?.albumName, "New Album");
  assert.equal(track?.trackMbid, "recording-mbid");
  assert.equal(track?.durationMs, 185000);
});

test("new releases do not substitute an unrelated artist top track", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [];
  source._getLastfmAlbumInfo = async () => null;
  source._getArtistTopTrackList = async () => [
    topTrack("Sober to Death", "Twin Fantasy (Face to Face)"),
  ];

  const track = await source._pickTrackFromRelease({
    artistName: "Car Seat Headrest",
    albumTitle: "Teen of Denial (Joe's Story)",
    albumMbid: "album-mbid",
    releaseYear: "2026",
  });

  assert.equal(track, null);
});

test("new releases accept an artist top track only when the album matches", async () => {
  const source = new FlowTrackSource();
  source._getMetadataAlbumTrackList = async () => [];
  source._getLastfmAlbumInfo = async () => null;
  source._getArtistTopTrackList = async () => [
    topTrack("Sober to Death", "Twin Fantasy (Face to Face)"),
    topTrack("Joe Gets Kicked", "Teen of Denial (Joe's Story)"),
  ];

  const track = await source._pickTrackFromRelease({
    artistName: "Car Seat Headrest",
    albumTitle: "Teen of Denial (Joe's Story)",
    albumMbid: "album-mbid",
    releaseYear: "2026",
  });

  assert.equal(track?.trackName, "Joe Gets Kicked");
  assert.equal(track?.albumName, "Teen of Denial (Joe's Story)");
});
