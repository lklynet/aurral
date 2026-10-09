import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [state, { db }, store, management, { registerMisc }, { scanMusicRoot }, { lidarrClient }, { getLibraryPage }] =
  await setupIsolatedBackend(
    "recent-artists",
    "backend/config/db-sqlite.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/libraryManagementStore.js",
    "backend/routes/library/handlers/misc.js",
    "backend/services/libraryFileScanner.js",
    "backend/services/lidarrClient.js",
    "backend/services/libraryQueryService.js",
  );

const routes = new Map();
registerMisc({
  get(route, ...handlers) { routes.set(route, handlers.at(-1)); },
  post() {},
});
const mbid = "11111111-1111-4111-8111-111111111111";
const images = [{ kind: "Poster", url: "https://example.test/aurral.jpg" }];

async function getRecent() {
  let body;
  await routes.get("/recent")({}, {
    set() {},
    status(code) { assert.fail(`Recent artists returned ${code}`); },
    json(value) { body = value; },
  });
  return body;
}

function addFile(artist, name, createdAt, { available = true } = {}) {
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${artist.id}:${name}`, artistId: artist.id, title: name,
  });
  const track = store.upsertLibraryTrack({ identityKey: `track:${artist.id}:${name}`, title: name });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const file = store.upsertLibraryMediaFile({
    trackId: track.id, albumId: album.id, source: "aurral", available, path: `/music/${artist.id}/${name}.flac`,
  });
  db.prepare("UPDATE library_media_files SET created_at = ? WHERE id = ?").run(Date.parse(createdAt), file.id);
}

test.beforeEach(() => {
  resetDatabase(db);
  management.invalidateLibraryManagementCache();
});
test.after(() => cleanupIsolatedState(state));

test("recent artists combines both owners with artwork and library identities while Lidarr is unavailable", async (t) => {
  t.mock.method(lidarrClient, "isConfigured", () => true);
  t.mock.method(lidarrClient, "request", async () => {
    throw new Error("Lidarr is unavailable");
  });
  const aurral = store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`, mbid, name: "Aurral Artist",
    metadata: { images, added: "2026-09-29T12:00:00Z", librarySource: "aurral" },
  });
  const lidarrImages = [{ coverType: "poster", remoteUrl: "https://example.test/lidarr.jpg" }];
  const lidarr = store.upsertLibraryArtist({
    identityKey: "lidarr-artist:123@deezer", name: "Lidarr Artist",
    metadata: { id: 12, foreignArtistId: "123@deezer", images: lidarrImages, added: "2026-09-28T12:00:00Z", librarySource: "lidarr" },
  });
  addFile(aurral, "Aurral Album", "2026-10-02T12:00:00Z");
  addFile(lidarr, "Lidarr Album", "2026-10-01T12:00:00Z");
  management.setLibraryManagement({ entityKind: "artist", entityId: aurral.id, managedBy: "aurral" });
  management.setLibraryManagement({ entityKind: "artist", entityId: lidarr.id, managedBy: "lidarr" });

  const recent = await getRecent();
  assert.deepEqual(recent.map((artist) => artist.managedBy), ["aurral", "lidarr"]);
  assert.equal(recent[0].mbid, mbid);
  assert.equal(recent[0].canonicalId, String(aurral.id));
  assert.deepEqual(recent[0].images, images);
  assert.equal(recent[1].mbid, null);
  assert.equal(recent[1].foreignArtistId, "123@deezer");
  assert.equal(recent[1].canonicalId, String(lidarr.id));
  assert.deepEqual(recent[1].images, lidarrImages);
});

test("recent artists follow the newest library file instead of the Lidarr added date", async (t) => {
  const oldLidarr = store.upsertLibraryArtist({
    identityKey: "name:old-lidarr", name: "Old Lidarr Artist",
    metadata: { added: "2020-01-01T12:00:00Z", librarySource: "lidarr" },
  });
  const recentLidarr = store.upsertLibraryArtist({
    identityKey: "name:recent-lidarr", name: "Recent Lidarr Artist",
    metadata: { added: "2026-10-05T12:00:00Z", librarySource: "lidarr" },
  });
  const withoutFiles = store.upsertLibraryArtist({
    identityKey: "name:without-files", name: "Artist Without Files",
    metadata: { added: "2026-10-06T12:00:00Z" },
  });
  store.upsertLibraryAlbum({ identityKey: "album:without-files", artistId: withoutFiles.id, title: "Wanted" });
  const missing = store.upsertLibraryArtist({ identityKey: "name:missing", name: "Missing Files Artist" });
  addFile(oldLidarr, "First Album", "2026-09-01T12:00:00Z");
  addFile(recentLidarr, "Only Album", "2026-09-15T12:00:00Z");
  addFile(oldLidarr, "New Album", "2026-10-07T12:00:00Z");
  addFile(missing, "Gone", "2026-10-08T12:00:00Z", { available: false });

  t.mock.method(lidarrClient, "isConfigured", () => false);
  const recent = await getRecent();
  assert.deepEqual(recent.map((artist) => artist.artistName),
    ["Missing Files Artist", "Old Lidarr Artist", "Recent Lidarr Artist"]);
  assert.deepEqual(recent.map((artist) => artist.added),
    ["2026-10-08T12:00:00.000Z", "2026-10-07T12:00:00.000Z", "2026-09-15T12:00:00.000Z"]);

  t.mock.method(lidarrClient, "isConfigured", () => true);
  assert.deepEqual((await getRecent()).map((artist) => artist.artistName),
    ["Old Lidarr Artist", "Recent Lidarr Artist"]);
});

test("recent artists returns the twenty with the newest files, including artists without MBIDs", async () => {
  for (let index = 1; index <= 25; index++) {
    const artist = store.upsertLibraryArtist({
      identityKey: `name:artist-${index}`,
      name: `Artist ${String(26 - index).padStart(2, "0")}`,
    });
    addFile(artist, "Album", `2026-09-${String(index).padStart(2, "0")}T12:00:00Z`);
  }
  const recent = await getRecent();
  assert.equal(recent.length, 20);
  assert.deepEqual(recent.map((artist) => artist.artistName),
    Array.from({ length: 20 }, (_, index) => `Artist ${String(index + 1).padStart(2, "0")}`));
  assert.ok(recent.every((artist) => artist.mbid === null && artist.canonicalId));
});

test("library pages resolve artists without albums or MBIDs", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "name:no-albums", name: "No Albums" });
  const artistId = String(artist.id);
  for (const kind of ["albums", "tracks"]) {
    const page = getLibraryPage({ kind, artistId, availableOnly: true });
    assert.deepEqual(page.items, []);
    assert.equal(page.artists[0]?.name, "No Albums");
    assert.equal(page.artists[0]?.mbid, null);
  }
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artistId);
  assert.deepEqual(getLibraryPage({ kind: "albums", artistId }).artists, []);
});

test("file scans retain artist identity, artwork and added date while updating file tags", async () => {
  const added = "2026-09-20T12:00:00Z";
  const artist = store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`, mbid, name: "Aurral Artist",
    metadata: { id: mbid, foreignArtistId: mbid, images, added, librarySource: "aurral" },
  });
  management.setLibraryManagement({ entityKind: "artist", entityId: artist.id, managedBy: "aurral" });
  const rootPath = path.join(state.baseDir, "music");
  const filePath = path.join(rootPath, "Aurral Artist", "Album", "Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "disposable music fixture");
  for (const title of ["Track", "Updated Track"]) {
    await writeFile(filePath, `disposable music fixture: ${title}`);
    const scan = await scanMusicRoot({
      rootPath, source: "aurral", changedPaths: [filePath],
      metadataReader: async () => ({ common: {
        artist: "Aurral Artist", album: "Album", title, musicbrainz_artistid: mbid,
      } }),
    });
    assert.equal(scan.filesIndexed, 1);
    const indexedAt = db.prepare("SELECT created_at FROM library_media_files").get().created_at;
    const [recent] = await getRecent();
    assert.equal(recent.canonicalId, String(artist.id));
    assert.equal(recent.mbid, mbid);
    assert.equal(recent.added, new Date(indexedAt).toISOString());
    assert.deepEqual(recent.images, images);
    const stored = JSON.parse(db.prepare("SELECT metadata_json FROM library_artists WHERE id = ?").get(artist.id).metadata_json);
    assert.equal(stored.tags.title, title);
    assert.equal(stored.librarySource, "aurral");
  }
  store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`, mbid, name: "Aurral Artist", metadata: { images: [] },
  });
  assert.deepEqual((await getRecent())[0].images, []);
});
