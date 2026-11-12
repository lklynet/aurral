import { describe, test } from "vite-plus/test";
import assert from "node:assert/strict";

import { buildSearchSections, type SearchItem } from "../../frontend/src/utils/searchNavigation.ts";
import { getSearchAlbumState } from "../../frontend/src/pages/searchPageUtils.ts";

const libraryAlbum = {
  type: "album",
  source: "library",
  id: "rg-ok",
  key: "library-album:1",
  title: "OK Computer",
  artistName: "Radiohead",
  status: "available",
  inLibrary: true,
};
const catalogAlbum = (id: string, title: string, primaryType = "Album") => ({
  type: "album",
  source: "brainzmash",
  id,
  key: id,
  title,
  artistName: "Radiohead",
  primaryType,
  inLibrary: false,
});
const track = (overrides: Record<string, unknown>) => ({
  type: "track",
  title: "Creep",
  artistName: "Radiohead",
  albumTitle: "Pablo Honey",
  inLibrary: false,
  ...overrides,
});

describe("buildSearchSections", () => {
  test("lists Library copies first and fills their gaps from the catalog copy", () => {
    const sections = buildSearchSections<SearchItem>({
      library: { albums: [libraryAlbum] },
      catalog: {
        albums: [catalogAlbum("rg-kid", "Kid A"), catalogAlbum("rg-ok", "OK Computer")],
      },
    });
    assert.deepEqual(
      sections.albums.map((album) => [album.title, album.source, album.primaryType]),
      [
        ["OK Computer", "library", "Album"],
        ["Kid A", "brainzmash", "Album"],
      ],
    );
  });

  test("splits singles and EPs from albums", () => {
    const sections = buildSearchSections<SearchItem>({
      catalog: {
        albums: [
          catalogAlbum("rg-creep", "Creep", "Single"),
          catalogAlbum("rg-lung", "My Iron Lung", "EP"),
          catalogAlbum("rg-kid", "Kid A"),
        ],
      },
    });
    assert.deepEqual(
      sections.albums.map((album) => album.title),
      ["Kid A"],
    );
    assert.deepEqual(
      sections.singles.map((album) => album.title),
      ["Creep", "My Iron Lung"],
    );
  });

  test.each([
    {
      name: "the same recording MBID",
      owned: { trackMbid: "rec-1", albumTitle: "Pablo Honey (Deluxe)" },
      found: { trackMbid: "rec-1" },
      merged: true,
    },
    {
      name: "the same artist, title, and album",
      owned: {},
      found: { title: "Creep (Remastered)" },
      merged: true,
    },
    {
      name: "the same title on another album",
      owned: {},
      found: { albumTitle: "Creep (Live)" },
      merged: false,
    },
  ])("merges an owned song with a catalog song on $name: $merged", ({ owned, found, merged }) => {
    const sections = buildSearchSections<SearchItem>({
      library: { tracks: [track({ id: "1", source: "library", inLibrary: true, ...owned })] },
      catalog: { tracks: [track({ id: "deezer:9", source: "deezer", ...found })] },
    });
    assert.deepEqual(
      sections.songs.map((song) => song.source),
      merged ? ["library"] : ["library", "deezer"],
    );
  });

  test("marks the top result owned when the Library has it", () => {
    const top = {
      type: "artist",
      id: "mbid-radiohead",
      name: "Radiohead",
      source: "brainzmash",
      inLibrary: false,
    };
    const sections = buildSearchSections<SearchItem>({
      library: {
        artists: [{ ...top, source: "library", libraryId: "4", inLibrary: true }],
      },
      catalog: { top, artists: [top] },
    });
    assert.equal(sections.top?.inLibrary, true);
    assert.equal(sections.top?.libraryId, "4");
  });
});

describe("getSearchAlbumState", () => {
  test.each([
    { album: { status: "available" }, downloading: false, kind: "complete" },
    { album: { status: "searching" }, downloading: false, kind: "active", label: "Searching" },
    { album: { status: "processing" }, downloading: false, kind: "active", label: "Queued" },
    { album: { status: "partial", trackFileCount: 3 }, downloading: true, kind: "active" },
    { album: { status: "partial", trackFileCount: 3 }, downloading: false, kind: "partial" },
    { album: { status: "partial", trackFileCount: 0 }, downloading: false, kind: "available" },
    {
      album: { managed: true, monitored: true, trackFileCount: 0, releaseDate: "2999-03-06" },
      downloading: false,
      kind: "waiting",
    },
    { album: {}, downloading: false, kind: "available" },
  ])("$album with downloading $downloading is $kind", ({ album, downloading, kind, label }) => {
    const state = getSearchAlbumState(album, downloading);
    assert.equal(state.kind, kind);
    if (label) assert.deepEqual(state, { kind, label });
  });
});
