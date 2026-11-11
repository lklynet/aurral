import { requireFixture } from "../playlists/fixtures.ts";
import { readArtist, readAlbum, readTrack } from "./fixtures.ts";
import { test, beforeAll, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "library-management-state",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

const store = await import("../../backend/services/libraryManagementStore.ts");
const libraryStore = await import("../../backend/services/libraryMediaStore.ts");
const { buildLibraryReadModel } = await import("../../backend/services/libraryReadModel.ts");
const { getLibrary, getLibraryPage } =
  await import("../../backend/services/libraryQueryService.ts");

beforeAll(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("manager state uses library ids and round-trips through the store", () => {
  store.setLibraryManagement({
    entityKind: "album",
    entityId: 7,
    monitorMode: "all",
  });
  assert.ok(store.getLibraryManagementEntry("album", "7"));
  const { updatedAt, ...entry } = requireFixture(store.getLibraryManagementEntry("album", 7));
  assert.deepEqual(entry, { monitorMode: "all", monitorRules: null });
  assert.ok(updatedAt != null && Number.isSafeInteger(updatedAt) && updatedAt > 0);

  assert.equal(store.clearLibraryManagement("album", 7), true);
  assert.equal(store.getLibraryManagementEntry("album", 7), null);
});

test("artist monitoring rules survive same-mode writes and clear when the mode changes", () => {
  const rules = { default: true, catalogAt: 1, newSince: 1 };
  const write = (
    fields: Omit<Parameters<typeof store.setLibraryManagement>[0], "entityKind" | "entityId">,
  ) => store.setLibraryManagement({ entityKind: "artist", entityId: 9, ...fields });

  write({ monitorMode: "all", monitorRules: rules });
  write({ monitorMode: "all" });
  assert.deepEqual(store.getLibraryManagementEntry("artist", 9)!.monitorRules, rules);

  write({ monitorMode: "none" });
  assert.equal(store.getLibraryManagementEntry("artist", 9)!.monitorRules, null);

  write({ monitorMode: "none", monitorRules: rules });
  write({ monitorMode: "none", monitorRules: null });
  assert.equal(store.getLibraryManagementEntry("artist", 9)!.monitorRules, null);
  store.clearLibraryManagement("artist", 9);
});

test("manager state written by another process is visible without a restart", async () => {
  const { default: Database } = await import("better-sqlite3");
  store.setLibraryManagement({ entityKind: "album", entityId: 11 });
  assert.ok(store.getLibraryManagementEntry("album", 11));
  assert.equal(store.getLibraryManagementEntry("album", 12), null);

  const otherProcess = new Database(db.name);
  try {
    const now = Date.now() + 1;
    otherProcess
      .prepare(
        `INSERT INTO library_management (entity_kind, entity_id, monitor_mode, created_at, updated_at)
       VALUES ('album', 12, 'monitored', ?, ?)`,
      )
      .run(now, now);
    assert.ok(store.getLibraryManagementEntry("album", 12));

    otherProcess
      .prepare(
        "UPDATE library_management SET monitor_mode = 'unmonitored', updated_at = ? WHERE entity_id = 12",
      )
      .run(now + 1);
    assert.equal(store.getLibraryManagementEntry("album", 12)!.monitorMode, "unmonitored");

    otherProcess
      .prepare("UPDATE library_management SET monitor_mode = 'monitored' WHERE entity_id = 12")
      .run();
    assert.equal(store.getLibraryManagementEntry("album", 12)!.monitorMode, "monitored");

    otherProcess.prepare("DELETE FROM library_management WHERE entity_id = 11").run();
    assert.equal(store.getLibraryManagementEntry("album", 11), null);
  } finally {
    otherProcess.close();
    store.clearLibraryManagement("album", 12);
  }
});

test("manager state rejects invalid kinds and ids", () => {
  assert.throws(
    () => store.setLibraryManagement({ entityKind: "track", entityId: 1 }),
    /entity kind/i,
  );
  assert.throws(
    () => store.setLibraryManagement({ entityKind: "artist", entityId: 0 }),
    /entity id/i,
  );
});

test("read model exposes managed and monitorMode without inventing values", () => {
  const library = {
    artists: [
      readArtist({
        id: 11,
        identityKey: "mbid:artist-managed",
        mbid: "artist-managed",
        name: "Managed Artist",

        sources: ["readonly"],
        available: true,
        metadata: { monitored: true },
      }),
      readArtist({
        id: 12,
        identityKey: "mbid:artist-open",
        mbid: "artist-open",
        name: "Open Artist",

        sources: ["aurral"],
        available: true,
        metadata: {},
      }),
    ],
    albums: [
      readAlbum({
        id: 21,
        identityKey: "rg:managed",
        artistId: 11,
        title: "Managed Album",
        trackIds: [31],
        sources: ["readonly"],
        available: true,
        metadata: {},
      }),
      readAlbum({
        id: 22,
        identityKey: "rg:open",
        artistId: 12,
        title: "Open Album",
        trackIds: [32],
        sources: ["aurral"],
        available: true,
        metadata: {},
      }),
    ],
    tracks: [
      readTrack({
        id: 31,
        mbid: "t31",
        title: "One",
        albums: [{ albumId: 21, discNumber: 1, trackNumber: 1 }],
        files: [],
        sources: ["readonly"],
        available: true,
      }),
      readTrack({
        id: 32,
        mbid: "t32",
        title: "Two",
        albums: [{ albumId: 22, discNumber: 1, trackNumber: 1 }],
        files: [],
        sources: ["aurral"],
        available: true,
      }),
    ],
  };

  store.setLibraryManagement({
    entityKind: "artist",
    entityId: 11,
    monitorMode: "all",
  });

  const model = buildLibraryReadModel(library);
  const managed = model.artists.find((a) => a.id === 11);
  assert.ok(managed != null);
  const open = model.artists.find((a) => a.id === 12);
  assert.ok(open != null);
  assert.equal(managed.managed, true);
  assert.equal(managed.monitorMode, "all");
  assert.equal(open.managed, false);
  assert.equal(open.monitorMode, null);
  assert.equal(model.albums.find((a) => a.id === 21)!.managed, false);
});

test("library page cache reflects ownership changes without manual invalidation", () => {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:cache-artist",
    mbid: "cache-artist",
    name: "Cache Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "rg:cache-album",
    artistId: artist.id,
    title: "Cache Album",
    albumArtist: artist.name,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "rec:cache-track",
    mbid: "cache-track",
    title: "Cache Track",
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    source: "aurral",
    path: "/library/Cache Artist/Cache Album/01 Cache Track.flac",
    format: "flac",
    available: true,
  });

  store.setLibraryManagement({ entityKind: "artist", entityId: artist.id });
  const before = getLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(before.items.find((entry) => String(entry.id) === String(artist.id))?.managed, true);

  store.clearLibraryManagement("artist", artist.id);
  const cleared = getLibraryPage({ kind: "artists", pageSize: 100 });
  assert.equal(
    cleared.items.find((entry) => String(entry.id) === String(artist.id))?.managed,
    false,
  );
});

test("library cache reflects ownership changed by another connection", async () => {
  const { default: Database } = await import("better-sqlite3");
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: "mbid:external-cache-artist",
    mbid: "external-cache-artist",
    name: "External Cache Artist",
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: "rg:external-cache-album",
    artistId: artist.id,
    title: "External Cache Album",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: "rec:external-cache-track",
    title: "External Cache Track",
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  store.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    monitorMode: "all",
  });
  assert.equal(getLibrary()!.artists.find((entry) => entry.id === artist.id)!.monitorMode, "all");

  const otherConnection = new Database(db.name);
  try {
    otherConnection
      .prepare(
        "UPDATE library_management SET monitor_mode = 'none' WHERE entity_kind = 'artist' AND entity_id = ?",
      )
      .run(artist.id);
    assert.equal(
      getLibrary()!.artists.find((entry) => entry.id === artist.id)!.monitorMode,
      "none",
    );
  } finally {
    otherConnection.close();
  }
});
