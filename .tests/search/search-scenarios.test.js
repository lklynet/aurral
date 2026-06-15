import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCatalogSearchContext,
  buildSearchContextIndex,
} from "../../backend/services/unifiedSearchService.js";
import {
  buildMixedSearchPageItems,
  buildMixedSuggestionItems,
} from "../../frontend/src/utils/searchNavigation.js";

const EMPTY_LIBRARY = { artists: [], tracks: [], playlists: [] };

function meiliArtist(name, score, id = name.toLowerCase().replace(/\s+/g, "-")) {
  return {
    type: "artist",
    id,
    key: id,
    name,
    sortName: name,
    inLibrary: false,
    hasMbid: true,
    score,
  };
}

function meiliAlbum(title, artistName, score, { id, artistMbid } = {}) {
  return {
    type: "album",
    id: id || `${title}-rg`,
    key: id || `${title}-rg`,
    title,
    artistName,
    artistMbid: artistMbid || `${artistName}-mbid`,
    inLibrary: false,
    score,
  };
}

function meiliTrack(title, artistName, score, { id, artistMbid, albumTitle, albumMbid } = {}) {
  return {
    type: "track",
    id: id || `${title}-rec`,
    key: id || `${title}-rec`,
    title,
    artistName,
    artistMbid: artistMbid || `${artistName}-mbid`,
    albumTitle: albumTitle || "",
    albumMbid: albumMbid || "",
    inLibrary: false,
    score,
  };
}

function buildResponse(query, catalog, { top = null, library = EMPTY_LIBRARY } = {}) {
  return { query, top, catalog, library };
}

test("artist search surfaces the artist first in suggestions", () => {
  const data = buildResponse("radiohead", {
    artists: [meiliArtist("Radiohead", 0.96, "radiohead-mbid")],
    albums: [meiliAlbum("OK Computer", "Radiohead", 0.78)],
    tracks: [meiliTrack("Paranoid Android", "Radiohead", 0.71)],
  }, {
    top: meiliArtist("Radiohead", 0.96, "radiohead-mbid"),
  });

  const items = buildMixedSuggestionItems(data, 5);
  assert.equal(items[0].type, "artist");
  assert.equal(items[0].name, "Radiohead");
});

test("album title search prioritizes the album and its artist", () => {
  const album = meiliAlbum("The Black Parade", "My Chemical Romance", 0.94, {
    id: "tbp-rg",
    artistMbid: "mcr-mbid",
  });
  const data = buildResponse("the black parade", {
    artists: [
      meiliArtist("My Chemical Romance", 0.87, "mcr-mbid"),
    ],
    albums: [album],
    tracks: [
      meiliTrack("Welcome to the Black Parade", "My Chemical Romance", 0.82, {
        albumTitle: "The Black Parade",
        albumMbid: "tbp-rg",
        artistMbid: "mcr-mbid",
      }),
    ],
  }, { top: album });

  const items = buildMixedSuggestionItems(data, 8);
  assert.equal(items[0].type, "album");
  assert.equal(items[0].title, "The Black Parade");
  assert.equal(
    items.some((item) => item.type === "artist" && item.name === "My Chemical Romance"),
    true,
  );
});

test("track search surfaces the song and keeps artist in results", () => {
  const track = meiliTrack("Bohemian Rhapsody", "Queen", 0.95, {
    id: "br-rec",
    artistMbid: "queen-mbid",
    albumTitle: "A Night at the Opera",
    albumMbid: "opera-rg",
  });
  const data = buildResponse("bohemian rhapsody", {
    artists: [meiliArtist("Queen", 0.88, "queen-mbid")],
    albums: [meiliAlbum("A Night at the Opera", "Queen", 0.79)],
    tracks: [track],
  }, { top: track });

  const items = buildMixedSuggestionItems(data, 5);
  assert.equal(items[0].type, "track");
  assert.equal(items[0].title, "Bohemian Rhapsody");
  assert.equal(items[0].artistName, "Queen");
});

test("stop-word queries use API top for the expected artist", () => {
  const beatles = meiliArtist("The Beatles", 0.97, "beatles-mbid");
  const data = buildResponse("the beatles", {
    artists: [beatles],
    albums: [meiliAlbum("Abbey Road", "The Beatles", 0.74)],
    tracks: [meiliTrack("Come Together", "The Beatles", 0.68)],
  }, { top: beatles });

  const items = buildMixedSuggestionItems(data, 5);
  assert.equal(items[0].name, "The Beatles");
});

test("catalog bucket order is preserved for albums and tracks", () => {
  const context = { artists: [], tracks: [], playlists: [], index: buildSearchContextIndex({}) };
  const catalog = applyCatalogSearchContext(
    {
      artists: [],
      albums: [
        meiliAlbum("Kid A", "Radiohead", 0.91),
        meiliAlbum("In Rainbows", "Radiohead", 0.89),
      ],
      tracks: [
        meiliTrack("Everything In Its Right Place", "Radiohead", 0.86),
        meiliTrack("15 Step", "Radiohead", 0.84),
      ],
    },
    "radiohead",
    context,
    5,
  );

  assert.deepEqual(
    catalog.albums.map((album) => album.title),
    ["Kid A", "In Rainbows"],
  );
  assert.deepEqual(
    catalog.tracks.map((track) => track.title),
    ["Everything In Its Right Place", "15 Step"],
  );
});

test("weak library matches do not override API top for album title queries", () => {
  const album = meiliAlbum("The Black Parade", "My Chemical Romance", 0.94, {
    artistMbid: "mcr-mbid",
  });
  const data = buildResponse("the black parade", {
    artists: [meiliArtist("My Chemical Romance", 0.87, "mcr-mbid")],
    albums: [album],
    tracks: [],
  }, {
    top: album,
    library: {
      artists: [
        {
          type: "artist",
          id: "tbk",
          name: "The Black Keys",
          score: 67,
          inLibrary: true,
          source: "library",
        },
      ],
      playlists: [
        {
          type: "playlist",
          id: "dw",
          name: "Discover Weekly",
          score: 67,
          inLibrary: true,
          source: "library",
        },
      ],
      tracks: [],
    },
  });

  const items = buildMixedSuggestionItems(data, 6);
  assert.equal(items[0].type, "album");
  assert.equal(items[0].title, "The Black Parade");
});

test("playlist context boosts catalog tracks without reshuffling album order", () => {
  const context = {
    artists: [{ mbid: "radiohead", artistName: "Radiohead" }],
    tracks: [],
    playlists: [
      {
        id: "pl-1",
        name: "Late Night",
        tracks: [
          {
            artistName: "Radiohead",
            trackName: "Paranoid Android",
            albumName: "OK Computer",
            artistMbid: "radiohead",
            albumMbid: "ok-computer",
            trackMbid: "paranoid-android",
          },
        ],
      },
    ],
  };
  const catalog = applyCatalogSearchContext(
    {
      artists: [meiliArtist("Paranoid Android", 0.91, "shadow")],
      albums: [meiliAlbum("OK Computer", "Radiohead", 0.88)],
      tracks: [
        meiliTrack("Paranoid Android", "Radiohead", 0.93, {
          id: "paranoid-android",
          artistMbid: "radiohead",
          albumTitle: "OK Computer",
          albumMbid: "ok-computer",
        }),
        meiliTrack("Karma Police", "Radiohead", 0.90, {
          artistMbid: "radiohead",
        }),
      ],
    },
    "paranoid android",
    { ...context, index: buildSearchContextIndex(context) },
    5,
  );

  assert.equal(catalog.tracks[0].title, "Paranoid Android");
  assert.equal(catalog.tracks[1].title, "Karma Police");
  assert.ok(catalog.tracks[0].contextBoost > 0);
});

test("search page excludes highlighted top artist while keeping albums", () => {
  const topArtist = meiliArtist("Bear", 0.94, "bear-mbid");
  const items = buildMixedSearchPageItems(
    buildResponse("bear", {
      artists: [topArtist, meiliArtist("Beartooth", 0.82)],
      albums: [meiliAlbum("Bear", "Remute", 0.88)],
      tracks: [],
    }, { top: topArtist }),
    { excludeItem: topArtist },
  );

  assert.equal(
    items.some((item) => item.type === "artist" && item.name === "Bear"),
    false,
  );
  assert.equal(items.some((item) => item.type === "album"), true);
});

test("album title search uses API top regardless of score scale", () => {
  const album = {
    type: "album",
    id: "tbp",
    title: "The Black Parade",
    artistName: "My Chemical Romance",
    artistMbid: "mcr",
    score: 0.94,
    source: "aurral-search",
  };
  const items = buildMixedSuggestionItems(
    {
      query: "the black parade",
      top: album,
      catalog: {
        artists: [
          {
            type: "artist",
            id: "shadow",
            name: "The Black Parade",
            score: 0.99,
            source: "aurral-search",
          },
        ],
        albums: [album],
        tracks: [],
      },
      library: { artists: [], tracks: [], playlists: [] },
    },
    8,
  );

  assert.equal(items[0].type, "album");
  assert.equal(items[0].title, "The Black Parade");
});

test("mixed suggestions preserve bucket order when API top is absent", () => {
  const items = buildMixedSuggestionItems(
    buildResponse("remute", {
      artists: [meiliArtist("Bear", 0.80)],
      albums: [meiliAlbum("Gold Collection", "Remute", 0.95)],
      tracks: [meiliTrack("Support Song", "Support Lesbiens", 0.88)],
    }),
    3,
  );

  assert.deepEqual(
    items.map((item) => item.type),
    ["artist", "album", "track"],
  );
});

const LIVE_SEARCH_BASE =
  process.env.AURRAL_SEARCH_URL || "https://search.aurral.org";
const LIVE_SEARCH_API_KEY = String(process.env.AURRAL_SEARCH_API_KEY || "").trim();
const LIVE_SEARCH_ENABLED =
  process.env.AURRAL_SEARCH_LIVE_TESTS === "1" ||
  process.env.AURRAL_SEARCH_ASSERT_TOP === "1" ||
  Boolean(process.env.AURRAL_SEARCH_URL || LIVE_SEARCH_API_KEY);
const LIVE_TOP_STRICT = process.env.AURRAL_SEARCH_ASSERT_TOP === "1";

async function fetchLiveSearch(query, mode, limit = 10) {
  const url = new URL(`${LIVE_SEARCH_BASE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("mode", mode);
  url.searchParams.set("limit", String(limit));
  const headers = { Accept: "application/json" };
  if (LIVE_SEARCH_API_KEY) {
    headers["X-Aurral-Search-Key"] = LIVE_SEARCH_API_KEY;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`aurral-search ${response.status}`);
  }
  return response.json();
}

const LIVE_SMOKE_SCENARIOS = [
  {
    query: "the beatles",
    mode: "full",
    limit: 20,
    expectInArtists: "the beatles",
  },
  {
    query: "bohemian rhapsody",
    mode: "full",
    limit: 20,
    expectInTracks: ["bohemian rhapsody", "queen"],
  },
  {
    query: "taylor swift",
    mode: "suggest",
    limit: 10,
    expectTopAlbum: ["taylor swift"],
  },
];

const LIVE_CONTRACT_SCENARIOS = [
  {
    query: "my chemical romance",
    mode: "full",
    limit: 20,
    expectTopArtist: "my chemical romance",
    expectInArtists: "my chemical romance",
  },
  {
    query: "the black parade",
    mode: "full",
    limit: 20,
    expectTopAlbum: ["the black parade", "my chemical romance"],
  },
  {
    query: "the used",
    mode: "full",
    limit: 20,
    expectTopArtist: "the used",
    expectInArtists: "the used",
  },
  {
    query: "radiohead",
    mode: "full",
    limit: 20,
    expectTopArtist: "radiohead",
    expectInArtists: "radiohead",
  },
];

const LIVE_SCENARIOS = LIVE_TOP_STRICT
  ? [...LIVE_CONTRACT_SCENARIOS, ...LIVE_SMOKE_SCENARIOS]
  : LIVE_SMOKE_SCENARIOS;

function bucketIncludes(items, pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.every((entry) => {
    const needle = String(entry).toLowerCase();
    return (items || []).some((item) => {
      const haystack = [
        item?.name,
        item?.title,
        item?.artistName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  });
}

function topMatches(item, pattern) {
  if (!item || !pattern) return true;
  const haystack = [
    item?.name,
    item?.title,
    item?.artistName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.every((entry) => haystack.includes(String(entry).toLowerCase()));
}

const liveCatalogTest = LIVE_SEARCH_ENABLED ? test : test.skip;

for (const scenario of LIVE_SCENARIOS) {
  liveCatalogTest(`live catalog ${scenario.mode}: "${scenario.query}"`, async () => {
    const payload = await fetchLiveSearch(
      scenario.query,
      scenario.mode,
      scenario.limit || 10,
    );
    const catalog = payload?.catalog || payload;

    if (scenario.expectTopArtist) {
      assert.equal(payload?.top?.type, "artist");
      assert.ok(
        topMatches(payload.top, scenario.expectTopArtist),
        `expected top artist to match ${scenario.expectTopArtist}, got ${payload?.top?.name}`,
      );
    }
    if (scenario.expectTopAlbum) {
      assert.equal(payload?.top?.type, "album");
      assert.ok(
        topMatches(payload.top, scenario.expectTopAlbum),
        `expected top album to match ${scenario.expectTopAlbum}, got ${payload?.top?.title}`,
      );
    }
    if (scenario.expectInArtists) {
      assert.ok(
        bucketIncludes(catalog.artists, scenario.expectInArtists),
        `artists bucket missing ${scenario.expectInArtists}`,
      );
    }
    if (scenario.expectInTracks) {
      assert.ok(
        bucketIncludes(catalog.tracks, scenario.expectInTracks),
        `tracks bucket missing ${scenario.expectInTracks}`,
      );
    }
    if (scenario.expectInAlbums) {
      assert.ok(
        bucketIncludes(catalog.albums, scenario.expectInAlbums),
        `albums bucket missing ${scenario.expectInAlbums}`,
      );
    }
  });
}
