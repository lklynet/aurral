import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCatalogSearchContext,
  buildSearchContextIndex,
  searchLocalFromData,
} from "../../backend/services/unifiedSearchService.js";
import {
  compareSearchResults,
  catalogPopularityToUnit,
  getSearchRankScore,
  normalizeRelevanceScore,
} from "../../backend/services/searchRanking.js";

test("searchLocalFromData returns playlist matches", () => {
  const result = searchLocalFromData(
    "paranoid android",
    {
      playlists: [
        {
          id: "pl-1",
          name: "Radiohead Favorites",
          tracks: [
            { artistName: "Radiohead", trackName: "Paranoid Android" },
          ],
        },
      ],
    },
    5,
  );

  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].name, "Radiohead Favorites");
  assert.equal(result.artists.length, 0);
  assert.equal(result.tracks.length, 0);
});

test("searchLocalFromData ignores playlist name matches without track content", () => {
  const result = searchLocalFromData(
    "summer vibes",
    {
      playlists: [
        {
          id: "pl-2",
          name: "Summer Vibes",
          tracks: [{ artistName: "Radiohead", trackName: "Creep" }],
        },
      ],
    },
    5,
  );

  assert.equal(result.playlists.length, 0);
});

test("searchLocalFromData matches playlists for band names with leading articles", () => {
  const result = searchLocalFromData(
    "the used",
    {
      playlists: [
        {
          id: "pl-used",
          name: "Emo Mix",
          tracks: [{ artistName: "The Used", trackName: "The Taste of Ink" }],
        },
      ],
    },
    5,
  );

  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].name, "Emo Mix");
});

test("searchLocalFromData ignores playlists without the full query phrase in tracks", () => {
  const indieSpotlightTracks = [
    { artistName: "The Neighbourhood", trackName: "A Little Death" },
    { artistName: "Arctic Monkeys", trackName: "No. 1 Party Anthem" },
    { artistName: "The Smiths", trackName: "There Is a Light That Never Goes Out" },
    { artistName: "The Strokes", trackName: "Call It Fate, Call It Karma" },
    { artistName: "The Killers", trackName: "Spaceman" },
    { artistName: "The 1975", trackName: "The Sound" },
  ];
  const result = searchLocalFromData(
    "the used",
    {
      playlists: [
        {
          id: "pl-indie",
          name: "Indie Spotlight",
          tracks: indieSpotlightTracks,
        },
      ],
    },
    5,
  );

  assert.equal(result.playlists.length, 0);
});

test("searchLocalFromData ignores playlist tracks with only partial query overlap", () => {
  const result = searchLocalFromData(
    "the used",
    {
      playlists: [
        {
          id: "pl-partial",
          name: "Random",
          tracks: [{ artistName: "Someone Used Something", trackName: "Hello" }],
        },
      ],
    },
    5,
  );

  assert.equal(result.playlists.length, 0);
});

test("searchLocalFromData returns library artist and track matches", () => {
  const result = searchLocalFromData(
    "radiohead",
    {
      artists: [
        {
          mbid: "a1b2c3",
          artistName: "Radiohead",
        },
      ],
      tracks: [
        {
          id: "lib-track-1",
          title: "Creep",
          artist: "Radiohead",
          album: "Pablo Honey",
          streamPath: "/library/file-stream/1/2",
        },
      ],
    },
    5,
  );

  assert.equal(result.artists.length, 1);
  assert.equal(result.artists[0].name, "Radiohead");
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].title, "Creep");
  assert.equal(result.artists[0].inLibrary, true);
  assert.equal(result.tracks[0].inLibrary, true);
});

test("searchLocalFromData ignores library artists that only share article words", () => {
  const result = searchLocalFromData(
    "the used",
    {
      artists: [
        { mbid: "used-mbid", artistName: "The Used" },
        { mbid: "1975-mbid", artistName: "The 1975" },
        { mbid: "almost-mbid", artistName: "The Almost" },
      ],
    },
    5,
  );

  assert.equal(result.artists.length, 1);
  assert.equal(result.artists[0].name, "The Used");
});

test("normalizeRelevanceScore preserves catalog popularity score ordering", () => {
  const popular = normalizeRelevanceScore({
    type: "track",
    source: "aurral-search",
    score: 185420,
  });
  const obscure = normalizeRelevanceScore({
    type: "track",
    source: "aurral-search",
    score: 4200,
  });

  assert.ok(popular > obscure);
  assert.ok(popular < 1);
  assert.ok(obscure < popular);
  assert.ok(catalogPopularityToUnit(185420) > 0.8);
});

test("catalog popularity scores outrank weak library partial matches", () => {
  const weakLibraryArtist = {
    type: "artist",
    score: 67,
    inLibrary: true,
    source: "library",
  };
  const catalogTrack = {
    type: "track",
    score: 185420,
    source: "aurral-search",
    inLibrary: false,
  };

  assert.ok(getSearchRankScore(catalogTrack) > getSearchRankScore(weakLibraryArtist));
  assert.ok(compareSearchResults(catalogTrack, weakLibraryArtist) < 0);
});

test("search ranking prioritizes strong playlist matches over catalog tracks", () => {
  const playlist = {
    type: "playlist",
    score: 90,
    inLibrary: true,
    source: "library",
  };
  const libraryTrack = {
    type: "track",
    score: 100,
    inLibrary: true,
    source: "library",
  };
  const catalogTrack = {
    type: "track",
    score: 0.94,
    inLibrary: false,
  };

  assert.ok(getSearchRankScore(playlist) > getSearchRankScore(catalogTrack));
  assert.ok(getSearchRankScore(libraryTrack) > getSearchRankScore(catalogTrack));
});

test("search ranking ignores weak library partial matches", () => {
  const weakLibraryArtist = {
    type: "artist",
    score: 67,
    inLibrary: true,
    source: "library",
  };
  const catalogArtist = {
    type: "artist",
    score: 0.97,
    inLibrary: false,
  };

  assert.ok(getSearchRankScore(catalogArtist) > getSearchRankScore(weakLibraryArtist));
});

test("catalog ranking uses library artists and playlist tracks as context", () => {
  const context = {
    artists: [{ mbid: "radiohead", artistName: "Radiohead" }],
    tracks: [
      {
        title: "No Surprises",
        artist: "Radiohead",
        album: "OK Computer",
      },
    ],
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
      artists: [
        {
          type: "artist",
          id: "paranoid-android-artist",
          name: "Paranoid Android",
          score: 0.91,
        },
      ],
      albums: [],
      tracks: [
        {
          type: "track",
          id: "paranoid-android",
          title: "Paranoid Android",
          artistName: "Radiohead",
          artistMbid: "radiohead",
          albumTitle: "OK Computer",
          albumMbid: "ok-computer",
          score: 0.88,
        },
      ],
    },
    "paranoid android",
    {
      ...context,
      index: buildSearchContextIndex(context),
    },
    5,
  );

  assert.equal(catalog.tracks[0].inPlaylist, true);
  assert.equal(catalog.tracks[0].artistInLibrary, true);
  assert.ok(catalog.tracks[0].contextBoost > 0);
  assert.equal(catalog.artists[0].id, "paranoid-android-artist");
  assert.equal(catalog.artists[0].name, "Paranoid Android");
});

test("catalog context marks full-mode library track matches", () => {
  const context = {
    artists: [],
    tracks: [
      {
        title: "No Surprises",
        artist: "Radiohead",
        album: "OK Computer",
      },
    ],
    playlists: [],
  };
  const catalog = applyCatalogSearchContext(
    {
      artists: [],
      albums: [],
      tracks: [
        {
          type: "track",
          id: "no-surprises",
          title: "No Surprises",
          artistName: "Radiohead",
          albumTitle: "OK Computer",
          score: 0.88,
        },
      ],
    },
    "no surprises",
    {
      ...context,
      index: buildSearchContextIndex(context),
    },
    5,
  );

  assert.equal(catalog.tracks[0].inLibrary, true);
  assert.ok(getSearchRankScore(catalog.tracks[0]) > 1);
});

test("applyCatalogSearchContext preserves artist bucket order", () => {
  const context = {
    artists: [
      {
        mbid: "say-anything",
        artistName: "Say Anything",
      },
    ],
    tracks: [],
    playlists: [],
  };
  const catalog = applyCatalogSearchContext(
    {
      artists: [
        {
          type: "artist",
          id: "the-used",
          name: "The Used",
          score: 0.94,
        },
      ],
      albums: [],
      tracks: [
        {
          type: "track",
          id: "the-band-the-used",
          title: "The Band the Used",
          artistName: "Say Anything",
          artistMbid: "say-anything",
          albumTitle: "The Noise Of Say Anything's Room Without...",
          score: 0.82,
        },
      ],
    },
    "the used",
    {
      ...context,
      index: buildSearchContextIndex(context),
    },
    5,
  );

  assert.equal(catalog.artists.length, 1);
  assert.equal(catalog.artists[0].name, "The Used");
  assert.equal(catalog.tracks[0].title, "The Band the Used");
});

test("catalog albums and tracks preserve engine order after context annotation", () => {
  const context = {
    artists: [],
    tracks: [],
    playlists: [],
    index: buildSearchContextIndex({}),
  };
  const catalog = applyCatalogSearchContext(
    {
      artists: [],
      albums: [
        {
          type: "album",
          id: "a",
          title: "Kid A",
          artistName: "Radiohead",
          score: 0.91,
        },
        {
          type: "album",
          id: "b",
          title: "In Rainbows",
          artistName: "Radiohead",
          score: 0.89,
        },
      ],
      tracks: [
        {
          type: "track",
          id: "t1",
          title: "Everything In Its Right Place",
          artistName: "Radiohead",
          score: 0.86,
        },
        {
          type: "track",
          id: "t2",
          title: "15 Step",
          artistName: "Radiohead",
          score: 0.84,
        },
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
