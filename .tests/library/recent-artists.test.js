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

test("recent artists selects the newest twenty across the library and includes artists without albums or MBIDs", async () => {
  for (let index = 1; index <= 25; index++) {
    store.upsertLibraryArtist({
      identityKey: `name:artist-${index}`,
      name: `Artist ${String(26 - index).padStart(2, "0")}`,
      metadata: { added: `2026-09-${String(index).padStart(2, "0")}T12:00:00Z` },
    });
  }
  const recent = await getRecent();
  assert.equal(recent.length, 20);
  assert.deepEqual(recent.map((artist) => artist.artistName),
    Array.from({ length: 20 }, (_, index) => `Artist ${String(index + 1).padStart(2, "0")}`));
  assert.ok(recent.every((artist) => artist.mbid === null && artist.canonicalId));
  const artistId = recent[0].canonicalId;
  for (const kind of ["albums", "tracks"]) {
    const page = getLibraryPage({ kind, artistId, availableOnly: true });
    assert.deepEqual(page.items, []);
    assert.equal(page.artists[0]?.name, recent[0].artistName);
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
    const [recent] = await getRecent();
    assert.equal(recent.canonicalId, String(artist.id));
    assert.equal(recent.mbid, mbid);
    assert.equal(recent.added, added);
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
