import type { toPublicLibraryPage } from "../../backend/routes/library/handlers/libraryIndex.ts";
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

const [isolatedState, { db }, { dbOps }, libraryStore, { setLibraryManagement }, { api }] =
  await setupIsolatedBackend(
    "canonical-available-only-route",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/libraryManagementStore.ts"),
    () => import("../../backend/routes/api.ts"),
  );

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
}) {
  const response = await app.request(`/library/canonical?${new URLSearchParams(query)}`);
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
    source: "lidarr",
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
    source: "lidarr",
    path: "/library/Owns Some/Catalog Album/01 Catalog Track.flac",
    available: false,
  });

  // Artist who owns nothing (e.g. deleted in Lidarr but lingering) — issue #750.
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
    source: "lidarr",
    path: "/library/Owns Nothing/Unowned Album/01 Unowned Track.flac",
    available: false,
  });

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
      managedBy: "aurral",
      monitorMode: monitored ? "monitored" : "unmonitored",
    });
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const titles = (page: Page<"albums" | "artists">) =>
  page.items.map((entry) => ("title" in entry ? entry.title : entry.name)).sort();

test("the Library lists what can be played and what Aurral is fetching, with or without Lidarr", async () => {
  for (const lidarr of [
    { url: "http://lidarr:8686", apiKey: "test-key", availableOnly: false },
    {},
  ]) {
    dbOps.updateSettings({ integrations: { lidarr } });
    const albums = await callLibraryPage({ kind: "albums", page: "1", pageSize: "50" });
    assert.deepEqual(titles(albums), ["Owned Album", "Requested Album"]);
    assert.equal(albums.total, 2);
    const artists = await callLibraryPage({ kind: "artists", page: "1", pageSize: "50" });
    assert.deepEqual(titles(artists), ["Fetching", "Owns Some"]);
    assert.deepEqual(
      artists.items.map((artist) => ("albumCount" in artist ? artist.albumCount : undefined)),
      [1, 1],
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
  }
});

test("a source filter lists and counts only albums and artists with playable files from that source", async () => {
  for (const kind of ["albums", "artists"] as const) {
    const page = await callLibraryPage({ kind, page: "1", pageSize: "50", source: "lidarr" });
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
});
