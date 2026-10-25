import { requireFixture } from "../playlists/fixtures.ts";
import { createRouteHarness, createResponse } from "./routeHarness.ts";
import type { getRecentlyAddedLibraryArtists } from "../../backend/services/libraryQueryService.ts";
type RecentArtist = ReturnType<typeof getRecentlyAddedLibraryArtists>[number] & { added?: string };
import assert from "node:assert/strict";
import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  store,
  management,
  { registerMisc },
  { scanMusicRoot },
  { lidarrClient },
  { getLibraryPage },
] = await setupIsolatedBackend(
  "recent-artists",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
  () => import("../../backend/routes/library/handlers/misc.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/lidarrClient.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
);

const routes = createRouteHarness(registerMisc);
const mbid = "11111111-1111-4111-8111-111111111111";
const images = [{ kind: "Poster", url: "https://example.test/aurral.jpg" }];

async function getRecent() {
  const response = createResponse<RecentArtist[]>();
  await routes.get("GET /recent")({}, response);
  assert.equal(response.statusCode, 200);
  return response.body;
}

function addFile(
  artist: import("../../backend/db/rows.ts").LibraryArtistsRow,
  name: string,
  createdAt: string,
  { available = true }: { available?: boolean } = {},
) {
  const album = store.upsertLibraryAlbum({
    identityKey: `album:${artist.id}:${name}`,
    artistId: artist.id,
    title: name,
  });
  const track = store.upsertLibraryTrack({
    identityKey: `track:${artist.id}:${name}`,
    title: name,
  });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  const file = store.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    available,
    path: `/music/${artist.id}/${name}.flac`,
  });
  assert.ok(file != null);
  db.prepare("UPDATE library_media_files SET created_at = ? WHERE id = ?").run(
    Date.parse(createdAt),
    file.id,
  );
}

function setArtistAddedAt(
  artist: import("../../backend/db/rows.ts").LibraryArtistsRow,
  addedAt: string,
) {
  db.prepare("UPDATE library_artists SET created_at = ? WHERE id = ?").run(
    Date.parse(addedAt),
    artist.id,
  );
}

beforeEach(() => {
  resetDatabase(db);
  management.invalidateLibraryManagementCache();
});
afterAll(() => cleanupIsolatedState(state));

test("recent artists combines both owners with artwork and library identities while Lidarr is unavailable", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "request").mockImplementation(async () => {
    throw new Error("Lidarr is unavailable");
  });
  const aurral = store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Aurral Artist",
    metadata: { images, added: "2026-09-29T12:00:00Z", librarySource: "aurral" },
  });
  const lidarrImages = [{ coverType: "poster", remoteUrl: "https://example.test/lidarr.jpg" }];
  const lidarr = store.upsertLibraryArtist({
    identityKey: "lidarr-artist:123@deezer",
    name: "Lidarr Artist",
    metadata: {
      id: 12,
      foreignArtistId: "123@deezer",
      images: lidarrImages,
      added: "2026-09-28T12:00:00Z",
      librarySource: "lidarr",
    },
  });
  addFile(aurral, "Aurral Album", "2026-10-02T12:00:00Z");
  addFile(lidarr, "Lidarr Album", "2026-10-01T12:00:00Z");
  setArtistAddedAt(aurral, "2026-10-02T12:00:00Z");
  setArtistAddedAt(lidarr, "2026-10-01T12:00:00Z");
  management.setLibraryManagement({
    entityKind: "artist",
    entityId: aurral.id,
    managedBy: "aurral",
  });
  management.setLibraryManagement({
    entityKind: "artist",
    entityId: lidarr.id,
    managedBy: "lidarr",
  });

  const recent = await getRecent();
  assert.deepEqual(
    recent.map((artist) => artist.managedBy),
    ["aurral", "lidarr"],
  );
  assert.equal(recent[0].mbid, mbid);
  assert.equal(recent[0].canonicalId, String(aurral.id));
  assert.deepEqual(recent[0].images, images);
  assert.equal(recent[1].mbid, null);
  assert.equal(recent[1].foreignArtistId, "123@deezer");
  assert.equal(recent[1].canonicalId, String(lidarr.id));
  assert.deepEqual(recent[1].images, lidarrImages);
});

test("recent artists follow the artist addition instead of newer tracks or provider dates", async () => {
  const oldLidarr = store.upsertLibraryArtist({
    identityKey: "name:old-lidarr",
    name: "Old Lidarr Artist",
    metadata: { added: "2020-01-01T12:00:00Z", librarySource: "lidarr" },
  });
  const recentLidarr = store.upsertLibraryArtist({
    identityKey: "name:recent-lidarr",
    name: "Recent Lidarr Artist",
    metadata: { added: "2026-10-05T12:00:00Z", librarySource: "lidarr" },
  });
  const withoutFiles = store.upsertLibraryArtist({
    identityKey: "name:without-files",
    name: "Artist Without Files",
    metadata: { added: "2026-10-06T12:00:00Z" },
  });
  store.upsertLibraryAlbum({
    identityKey: "album:without-files",
    artistId: withoutFiles.id,
    title: "Wanted",
  });
  const missing = store.upsertLibraryArtist({
    identityKey: "name:missing",
    name: "Missing Files Artist",
  });
  addFile(oldLidarr, "First Album", "2026-09-01T12:00:00Z");
  addFile(recentLidarr, "Only Album", "2026-09-15T12:00:00Z");
  addFile(oldLidarr, "New Album", "2026-10-07T12:00:00Z");
  addFile(missing, "Gone", "2026-10-08T12:00:00Z", { available: false });
  setArtistAddedAt(oldLidarr, "2026-09-01T12:00:00Z");
  setArtistAddedAt(recentLidarr, "2026-09-15T12:00:00Z");
  setArtistAddedAt(withoutFiles, "2026-10-06T12:00:00Z");
  setArtistAddedAt(missing, "2026-10-08T12:00:00Z");

  for (const connected of [false, true]) {
    vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => connected);
    const recent = await getRecent();
    assert.deepEqual(
      recent.map((artist) => artist.artistName),
      ["Recent Lidarr Artist", "Old Lidarr Artist"],
    );
    assert.deepEqual(
      recent.map((artist) => artist.added),
      ["2026-09-15T12:00:00.000Z", "2026-09-01T12:00:00.000Z"],
    );
  }
});

test("recent artists returns the twenty newest artists, including artists without MBIDs", async () => {
  for (let index = 1; index <= 25; index++) {
    const artist = store.upsertLibraryArtist({
      identityKey: `name:artist-${index}`,
      name: `Artist ${String(26 - index).padStart(2, "0")}`,
    });
    addFile(artist, "Album", `2026-09-${String(index).padStart(2, "0")}T12:00:00Z`);
    setArtistAddedAt(artist, `2026-09-${String(index).padStart(2, "0")}T12:00:00Z`);
  }
  const recent = await getRecent();
  assert.equal(recent.length, 20);
  assert.deepEqual(
    recent.map((artist) => artist.artistName),
    Array.from({ length: 20 }, (_, index) => `Artist ${String(index + 1).padStart(2, "0")}`),
  );
  assert.ok(recent.every((artist) => artist.mbid === null && artist.canonicalId));
});

test("recent artists collapse duplicate canonical artist rows", async () => {
  const canonicalMbid = "22222222-2222-4222-8222-222222222222";
  const original = store.upsertLibraryArtist({
    identityKey: `mbid:${canonicalMbid}`,
    mbid: canonicalMbid,
    name: "Duplicate Artist",
  });
  const duplicate = store.upsertLibraryArtist({
    identityKey: `legacy:${canonicalMbid}`,
    mbid: canonicalMbid,
    name: "Duplicate Artist",
  });
  addFile(original, "Original Album", "2026-10-01T12:00:00Z", { available: false });
  addFile(duplicate, "Duplicate Album", "2026-10-20T12:00:00Z");
  setArtistAddedAt(original, "2026-10-01T12:00:00Z");
  setArtistAddedAt(duplicate, "2026-10-20T12:00:00Z");

  const recent = await getRecent();

  assert.equal(recent.length, 1);
  assert.equal(recent[0].mbid, canonicalMbid);
  assert.equal(recent[0].added, "2026-10-01T12:00:00.000Z");
});

test("recent artists keep unidentified artists with the same name separate", async () => {
  const first = store.upsertLibraryArtist({
    identityKey: "source-one:same-name",
    name: "Same Name",
  });
  const second = store.upsertLibraryArtist({
    identityKey: "source-two:same-name",
    name: "Same Name",
  });
  addFile(first, "First Album", "2026-10-01T12:00:00Z");
  addFile(second, "Second Album", "2026-10-02T12:00:00Z");
  setArtistAddedAt(first, "2026-10-01T12:00:00Z");
  setArtistAddedAt(second, "2026-10-02T12:00:00Z");

  const recent = await getRecent();

  assert.equal(recent.length, 2);
  assert.deepEqual(
    recent.map((artist) => artist.canonicalId),
    [String(second.id), String(first.id)],
  );
});

test("library pages resolve artists without albums or MBIDs", () => {
  const artist = store.upsertLibraryArtist({ identityKey: "name:no-albums", name: "No Albums" });
  const artistId = String(artist.id);
  for (const kind of ["albums", "tracks"]) {
    const page = getLibraryPage({ kind, artistId, availableOnly: true });
    assert.deepEqual([...page.items], []);
    assert.equal(page.artists[0]?.name, "No Albums");
    assert.equal(page.artists[0]?.mbid, null);
  }
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artistId);
  assert.deepEqual([...getLibraryPage({ kind: "albums", artistId }).artists], []);
});

test("file scans retain artist identity, artwork and added date while updating file tags", async () => {
  const added = "2026-09-20T12:00:00Z";
  const artist = store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Aurral Artist",
    metadata: { id: mbid, foreignArtistId: mbid, images, added, librarySource: "aurral" },
  });
  management.setLibraryManagement({
    entityKind: "artist",
    entityId: artist.id,
    managedBy: "aurral",
  });
  setArtistAddedAt(artist, added);
  const rootPath = path.join(state.baseDir, "music");
  const filePath = path.join(rootPath, "Aurral Artist", "Album", "Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "disposable music fixture");
  for (const title of ["Track", "Updated Track"]) {
    await writeFile(filePath, `disposable music fixture: ${title}`);
    const scan = await scanMusicRoot({
      rootPath,
      source: "aurral",
      changedPaths: [filePath],
      metadataReader: async () => ({
        common: {
          artist: "Aurral Artist",
          album: "Album",
          title,
          musicbrainz_artistid: [mbid],
        },
      }),
    });
    assert.equal(scan.filesIndexed, 1);
    const [recent] = await getRecent();
    assert.equal(recent.canonicalId, String(artist.id));
    assert.equal(recent.mbid, mbid);
    assert.equal(recent.added, new Date(added).toISOString());
    assert.deepEqual(recent.images, images);
    const stored = JSON.parse(
      requireFixture(
        requireFixture(db)
          .prepare<unknown[], { metadata_json: string | null }>(
            "SELECT metadata_json FROM library_artists WHERE id = ?",
          )!
          .get(artist.id)!.metadata_json,
      ),
    );
    assert.equal(stored.tags.title, title);
    assert.equal(stored.librarySource, "aurral");
  }
  store.upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name: "Aurral Artist",
    metadata: { images: [] },
  });
  assert.deepEqual([...(await getRecent())[0].images], []);
});
