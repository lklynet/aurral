import type { toPublicLibraryPage } from "../../backend/services/publicLibrary.ts";
import { signedInAs } from "../helpers/honoApp.ts";
type Page<Kind extends "albums" | "artists"> = Extract<
  ReturnType<typeof toPublicLibraryPage>,
  { kind: Kind }
>;
import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, libraryStore, { setLibraryManagement }, { api }] =
  await setupIsolatedBackend(
    "canonical-available-only-route",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/libraryManagementStore.ts"),
    () => import("../../backend/routes/api.ts"),
  );

const { getLibrarySearchPage, LIBRARY_VIEW } =
  await import("../../backend/services/libraryQueryService.ts");
const { libraryManager } = await import("../../backend/services/libraryManager.ts");
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

const app = signedInAs(undefined).route("/", api);
async function callLibraryPage<Kind extends "artists" | "albums">(query: {
  kind: Kind;
  page: string;
  pageSize: string;
  artistId?: string;
  source?: string;
  availableOnly?: string;
  sort?: string;
}) {
  const response = await app.request(`/library?${new URLSearchParams(query)}`);
  const page: Page<Kind> = await response.json();
  return page;
}

beforeAll(() => {
  resetDatabase(db);

  // Artist who owns some but not all of their discography (the issue's "Muse" case).
  const partialArtist = upsertLibraryArtist({
    identityKey: "partial-artist",
    name: "Owns Some",
  });
  const ownedAlbum = upsertLibraryAlbum({
    identityKey: "owned-album",
    artistId: partialArtist.id,
    title: "Owned Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: "owned-track",
    title: "Owned Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: ownedAlbum.id, trackId: ownedTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: ownedAlbum.id,
    source: "readonly",
    path: "/library/Owns Some/Owned Album/01 Owned Track.flac",
    available: true,
  });

  const catalogAlbum = upsertLibraryAlbum({
    identityKey: "catalog-album",
    artistId: partialArtist.id,
    title: "Catalog Album",
  });
  const catalogTrack = upsertLibraryTrack({
    identityKey: "catalog-track",
    title: "Catalog Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: catalogAlbum.id, trackId: catalogTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: catalogTrack.id,
    albumId: catalogAlbum.id,
    source: "readonly",
    path: "/library/Owns Some/Catalog Album/01 Catalog Track.flac",
    available: false,
  });

  // Artist who owns nothing but lingers in the index: issue #750.
  const emptyArtist = upsertLibraryArtist({
    identityKey: "empty-artist",
    name: "Owns Nothing",
  });
  const emptyAlbum = upsertLibraryAlbum({
    identityKey: "empty-album",
    artistId: emptyArtist.id,
    title: "Unowned Album",
  });
  const emptyTrack = upsertLibraryTrack({
    identityKey: "empty-track",
    title: "Unowned Track",
    artistName: emptyArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: emptyAlbum.id, trackId: emptyTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: emptyTrack.id,
    albumId: emptyAlbum.id,
    source: "readonly",
    path: "/library/Owns Nothing/Unowned Album/01 Unowned Track.flac",
    available: false,
  });

  for (const [name, monitorRules] of [
    ["Monitored Empty", { default: true }],
    ["Deleted Empty", null],
  ] as const) {
    const artist = upsertLibraryArtist({
      identityKey: `${name}-artist`,
      name,
      metadata: { monitored: true },
    });
    setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      monitorMode: monitorRules ? "all" : "none",
      monitorRules,
    });
  }

  const fetchingArtist = upsertLibraryArtist({ identityKey: "fetching-artist", name: "Fetching" });
  for (const [title, monitored] of [
    ["Requested Album", true],
    ["Unmonitored Album", false],
  ] as const) {
    const album = upsertLibraryAlbum({
      identityKey: `aurral-${title}`,
      artistId: fetchingArtist.id,
      title,
      metadata: { librarySource: "aurral", trackListComplete: true, monitored },
    });
    const track = upsertLibraryTrack({
      identityKey: `aurral-${title}-track`,
      title: `${title} Track`,
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    setLibraryManagement({
      entityKind: "album",
      entityId: album.id,
      monitorMode: monitored ? "monitored" : "unmonitored",
    });
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const titles = (page: Page<"albums" | "artists">) =>
  page.items.map((entry) => ("title" in entry ? entry.title : entry.name)).sort();

test("the Library lists what can be played and what Aurral is fetching", async () => {
  const albums = await callLibraryPage({ kind: "albums", page: "1", pageSize: "50" });
  assert.deepEqual(titles(albums), ["Owned Album", "Requested Album"]);
  assert.equal(albums.total, 2);
  const artists = await callLibraryPage({ kind: "artists", page: "1", pageSize: "50" });
  assert.deepEqual(titles(artists), ["Fetching", "Monitored Empty", "Owns Some"]);
  assert.equal(artists.total, 3);
  assert.deepEqual(
    artists.items.map((artist) => ("albumCount" in artist ? artist.albumCount : undefined)),
    [1, 0, 1],
  );
  const ownsSome = artists.items.find((artist) => artist.name === "Owns Some");
  assert.ok(ownsSome);
  assert.deepEqual(
    titles(
      await callLibraryPage({
        kind: "albums",
        page: "1",
        pageSize: "50",
        artistId: String(ownsSome.id),
      }),
    ),
    ["Owned Album"],
  );
});

test("Library search finds artists Aurral monitors before their music arrives", () => {
  const search = getLibrarySearchPage({ availableOnly: LIBRARY_VIEW, query: "empty" });
  assert.deepEqual(
    search.artists.map((artist) => [artist.name, artist.albumCount]),
    [["Monitored Empty", 0]],
  );
});

test("a source filter lists and counts only albums and artists with playable files from that source", async () => {
  for (const kind of ["albums", "artists"] as const) {
    const page = await callLibraryPage({ kind, page: "1", pageSize: "50", source: "readonly" });
    assert.deepEqual(titles(page), [kind === "albums" ? "Owned Album" : "Owns Some"]);
    assert.equal(page.total, 1);
  }
});

test("an explicit availableOnly query param overrides the Library's rule", async () => {
  const playable = await callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(titles(playable), ["Owned Album"]);
  const everything = await callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "false",
  });
  assert.equal(everything.total, 5);
  const playableArtists = await callLibraryPage({
    kind: "artists",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(titles(playableArtists), ["Owns Some"]);
});

test("Recently added ranks an artist with no music yet by when it was added", async () => {
  const { newest } = db
    .prepare("SELECT MAX(created_at) AS newest FROM library_media_files")
    .get() as { newest: number };
  const setAddedAt = db.prepare("UPDATE library_artists SET created_at = ? WHERE name = ?");
  setAddedAt.run(newest + 60_000, "Monitored Empty");
  setAddedAt.run(1, "Fetching");
  const artists = await callLibraryPage({
    kind: "artists",
    page: "1",
    pageSize: "50",
    sort: "newest",
  });
  assert.deepEqual(
    artists.items.map((artist) => artist.name),
    ["Monitored Empty", "Owns Some", "Fetching"],
  );
});

test("an artist Aurral starts monitoring ranks as just added, and deleting it takes it out of the Library", async () => {
  const mbid = "d1111111-1111-4111-8111-111111111111";
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Known Empty",
    metadata: { added: "2000-01-01T00:00:00.000Z" },
  });
  db.prepare("UPDATE library_artists SET created_at = 1 WHERE id = ?").run(artist.id);
  const originalPlan = libraryManager.planArtistMonitoring;
  libraryManager.planArtistMonitoring = async () => ({
    releases: [],
    topTracks: [],
    skipped: [],
    skippedTracks: [],
    topTracksError: null,
  });
  const newest = async () =>
    (
      await callLibraryPage({ kind: "artists", page: "1", pageSize: "50", sort: "newest" })
    ).items.map((entry) => entry.name);
  try {
    assert.ok(!(await newest()).includes("Known Empty"));
    const monitored = await libraryManager.applyArtistMonitoring(mbid, {
      useDefault: true,
      rules: null,
    });
    assert.ok(!("error" in monitored));
    const names = await newest();
    assert.ok(names.includes("Known Empty"));
    assert.ok(names.indexOf("Known Empty") < names.indexOf("Owns Some"));

    const deleted = await libraryManager.deleteArtist(mbid, false);
    assert.equal(deleted.success, true);
    assert.ok(!(await newest()).includes("Known Empty"));
  } finally {
    libraryManager.planArtistMonitoring = originalPlan;
  }
});
