import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMixedSearchPageItems,
  buildMixedSuggestionItems,
  buildSearchArtistResults,
  buildUnifiedSuggestionSections,
  getReleaseNavigationTarget,
  resolveSearchTopArtist,
  resolveSearchTopResult,
} from "../../frontend/src/utils/searchNavigation.js";

test("resolveSearchTopResult uses API top when it is an artist", () => {
  const artist = {
    type: "artist",
    id: "mcr",
    name: "My Chemical Romance",
    score: 0.998,
  };
  const resolved = resolveSearchTopResult({
    query: "my chemical romance",
    top: artist,
    catalog: { artists: [artist], albums: [], tracks: [] },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "artist");
  assert.equal(resolved?.name, "My Chemical Romance");
});

test("resolveSearchTopResult prefers artist over album when query matches artist name", () => {
  const artist = {
    type: "artist",
    id: "fob",
    name: "Fall Out Boy",
    score: 0.95,
  };
  const album = {
    type: "album",
    id: "fob-album",
    title: "Fall Out Boy",
    artistName: "Fall Out Boy",
    artistMbid: "fob",
    score: 0.98,
  };
  const resolved = resolveSearchTopResult({
    query: "fall out boy",
    top: album,
    catalog: { artists: [artist], albums: [album], tracks: [] },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "artist");
  assert.equal(resolved?.name, "Fall Out Boy");
});

test("resolveSearchTopResult prefers artist when catalog spacing differs from query", () => {
  const album = {
    type: "album",
    id: "fob-album",
    title: "Fall Out Boy",
    artistName: "Fall Out Boy",
    artistMbid: "516cef4d-0718-4007-9939-f9b38af3f784",
    score: 1,
  };
  const resolved = resolveSearchTopResult({
    query: "fall out boy",
    top: album,
    catalog: {
      artists: [
        { type: "artist", id: "bad-1", name: "Fallout Boy", score: 0.9 },
        { type: "artist", id: "bad-2", name: "Falloutboy", score: 0.88 },
      ],
      albums: [album],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "artist");
  assert.equal(resolved?.name, "Fall Out Boy");
  assert.equal(resolved?.id, "516cef4d-0718-4007-9939-f9b38af3f784");
});

test("resolveSearchTopResult uses API top when it is an album", () => {
  const album = {
    type: "album",
    id: "tbp",
    title: "The Black Parade",
    artistName: "My Chemical Romance",
    artistMbid: "mcr",
    score: 0.94,
  };
  const resolved = resolveSearchTopResult({
    query: "the black parade",
    top: album,
    catalog: {
      artists: [
        {
          type: "artist",
          id: "mcr",
          name: "My Chemical Romance",
          score: 0.87,
        },
      ],
      albums: [album],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "album");
  assert.equal(resolved?.title, "The Black Parade");
  assert.equal(resolved?.artistName, "My Chemical Romance");
});

test("resolveSearchTopArtist derives the performer when API top is an album", () => {
  const artist = {
    type: "artist",
    id: "mcr",
    name: "My Chemical Romance",
    score: 0.87,
  };
  const resolved = resolveSearchTopArtist({
    query: "the black parade",
    top: {
      type: "album",
      id: "tbp",
      title: "The Black Parade",
      artistName: "My Chemical Romance",
      artistMbid: "mcr",
      score: 0.94,
    },
    catalog: {
      artists: [artist],
      albums: [],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "artist");
  assert.equal(resolved?.name, "My Chemical Romance");
  assert.equal(resolved?.id, "mcr");
});

test("resolveSearchTopArtist synthesizes an artist from track top metadata", () => {
  const resolved = resolveSearchTopArtist({
    query: "bohemian rhapsody",
    top: {
      type: "track",
      id: "br",
      title: "Bohemian Rhapsody",
      artistName: "Queen",
      artistMbid: "queen",
      score: 0.95,
    },
    catalog: {
      artists: [],
      albums: [],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(resolved?.type, "artist");
  assert.equal(resolved?.name, "Queen");
  assert.equal(resolved?.id, "queen");
});

test("buildMixedSuggestionItems uses API top as the first item", () => {
  const top = {
    type: "artist",
    id: "mcr",
    name: "My Chemical Romance",
    score: 0.998,
  };
  const items = buildMixedSuggestionItems({
    query: "my chemical romance",
    top,
    catalog: {
      artists: [top],
      albums: [],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(items[0]?.type, "artist");
  assert.equal(items[0]?.name, "My Chemical Romance");
});

test("buildMixedSuggestionItems dedupes artists with the same display name", () => {
  const items = buildMixedSuggestionItems({
    catalog: {
      artists: [
        { type: "artist", id: "a1", name: "Bear", score: 0.92 },
        { type: "artist", id: "a2", name: "Bear", score: 0.88 },
        { type: "artist", id: "a3", name: "Beartooth", score: 0.75 },
      ],
      albums: [],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(items.filter((item) => item.type === "artist").length, 2);
  assert.equal(items[0].name, "Bear");
  assert.equal(items[0].id, "a1");
});

test("buildMixedSuggestionItems preserves catalog bucket order", () => {
  const items = buildMixedSuggestionItems({
    catalog: {
      artists: [{ type: "artist", id: "a1", name: "Bear", score: 0.72 }],
      albums: [
        {
          type: "album",
          id: "rg1",
          title: "Bear",
          artistName: "Remute",
          score: 0.95,
        },
      ],
      tracks: [
        {
          type: "track",
          id: "r1",
          title: "Bear",
          artistName: "Support Lesbiens",
          score: 0.84,
        },
      ],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.deepEqual(
    items.map((item) => item.type),
    ["artist", "album", "track"],
  );
});

test("getReleaseNavigationTarget preserves focused track album metadata", () => {
  const target = getReleaseNavigationTarget({
    type: "track",
    id: "track-1",
    title: "Welcome to the Black Parade",
    artistMbid: "artist-1",
    artistName: "My Chemical Romance",
    albumMbid: "album-1",
    albumTitle: "The Black Parade",
    releaseYear: "2006",
    primaryType: "Album",
    coverUrl: "https://example.test/cover.jpg",
  });

  assert.equal(
    target.pathname,
    "/artist/artist-1/release/album-1",
  );
  assert.equal(target.state.focusReleaseGroupMbid, "album-1");
  assert.equal(target.state.focusTrackMbid, "track-1");
  assert.equal(target.state.focusTrackTitle, "Welcome to the Black Parade");
  assert.deepEqual(target.state.focusReleaseGroup, {
    id: "album-1",
    title: "The Black Parade",
    firstReleaseDate: "2006",
    primaryType: "Album",
    secondaryTypes: [],
    coverUrl: "https://example.test/cover.jpg",
    deezerAlbumId: "",
    rating: null,
  });
});

test("buildMixedSuggestionItems excludes library playlists from mixed results", () => {
  const items = buildMixedSuggestionItems({
    catalog: {
      artists: [],
      albums: [],
      tracks: [
        {
          type: "track",
          id: "r1",
          title: "Bear",
          artistName: "Support Lesbiens",
          score: 0.94,
        },
      ],
    },
    library: {
      artists: [],
      tracks: [],
      playlists: [
        {
          type: "playlist",
          id: "pl-1",
          name: "Bear Mix",
          score: 0.88,
          inLibrary: true,
        },
      ],
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].type, "track");
});

test("buildMixedSuggestionItems prefers catalog for album title queries when API top is set", () => {
  const album = {
    type: "album",
    id: "tbp",
    title: "The Black Parade",
    artistName: "My Chemical Romance",
    artistMbid: "mcr",
    score: 0.94,
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
            score: 0.91,
          },
        ],
        albums: [album],
        tracks: [
          {
            type: "track",
            id: "willie",
            title: "The Black Parade",
            artistName: "Willie Nile",
            artistMbid: "willie",
            score: 0.86,
          },
        ],
      },
      library: { artists: [], tracks: [], playlists: [] },
    },
    8,
  );

  assert.equal(items[0].type, "album");
  assert.equal(items[0].title, "The Black Parade");
});

test("buildMixedSearchPageItems excludes the highlighted top item", () => {
  const topArtist = {
    type: "artist",
    id: "bear-mbid",
    name: "Bear",
    score: 0.94,
  };
  const items = buildMixedSearchPageItems(
    {
      query: "bear",
      top: topArtist,
      catalog: {
        artists: [topArtist, { type: "artist", id: "a2", name: "Beartooth", score: 0.82 }],
        albums: [{ type: "album", id: "rg1", title: "Bear", artistName: "Remute", score: 0.88 }],
        tracks: [],
      },
      library: { artists: [], tracks: [], playlists: [] },
    },
    { excludeItem: topArtist },
  );

  assert.equal(
    items.some((item) => item.type === "artist" && item.name === "Bear"),
    false,
  );
  assert.equal(items.some((item) => item.type === "album"), true);
});

test("buildUnifiedSuggestionSections avoids repeating the top artist name", () => {
  const topArtist = {
    type: "artist",
    id: "bear-mbid",
    name: "Bear",
    score: 0.94,
  };
  const sections = buildUnifiedSuggestionSections({
    query: "bear",
    top: topArtist,
    catalog: {
      artists: [
        topArtist,
        { type: "artist", id: "a2", name: "Beartooth", score: 0.82 },
      ],
      albums: [],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  const artistItems =
    sections.find((section) => section.key === "artists")?.items || [];
  assert.equal(artistItems.length, 1);
  assert.equal(artistItems[0].name, "Beartooth");
});

test("buildSearchArtistResults includes resolved top artist when catalog artists bucket is empty", () => {
  const album = {
    type: "album",
    id: "self-titled",
    title: "The White Stripes",
    artistName: "The White Stripes",
    artistMbid: "11ae9fbb-f3d7-4a47-936f-4c0a04d3b3b5",
    score: 1,
  };
  const artists = buildSearchArtistResults({
    query: "the white stripes",
    top: album,
    catalog: {
      artists: [],
      albums: [album],
      tracks: [],
    },
    library: { artists: [], tracks: [], playlists: [] },
  });

  assert.equal(artists.length, 1);
  assert.equal(artists[0].name, "The White Stripes");
  assert.equal(artists[0].id, "11ae9fbb-f3d7-4a47-936f-4c0a04d3b3b5");
});
