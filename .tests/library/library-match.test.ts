import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { writeFlacFixture } from "../helpers/flacFixture.ts";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, libraryStore, provider, indexService, { scanMusicRoot }] =
  await setupIsolatedBackend(
    "library-match",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/providers/brainzmashProvider.ts"),
    () => import("../../backend/services/libraryIndexService.ts"),
    () => import("../../backend/services/libraryFileScanner.ts"),
  );

const { api } = await import("../../backend/routes/api.ts");
const { getArtistLibraryLookup } = await import("../../backend/routes/library/handlers/misc.ts");

const KNOWN_MBID = "55555555-5555-4555-8555-555555555551";
const OTHER_MBID = "55555555-5555-4555-8555-555555555552";
const MISSING_MBID = "55555555-5555-4555-8555-555555555553";
const MATCHED_BY_NAME_MBID = "55555555-5555-4555-8555-555555555554";
const LINKED_MBID = "55555555-5555-4555-8555-555555555555";
const PICKED_GROUP = "66666666-6666-4666-8666-666666666661";
const OTHER_GROUP = "66666666-6666-4666-8666-666666666662";
const MISSING_GROUP = "66666666-6666-4666-8666-666666666663";
const ALBUM_ARTIST_MBID = "55555555-5555-4555-8555-555555555557";

let providerAvailable = true;
let server: { url: string; close: () => Promise<void> };
let musicRoot: string;

beforeAll(async () => {
  resetDatabase(db);
  server = await createMockHttpServer((request, response) => {
    if (!providerAvailable) {
      response.writeHead(500);
      response.end();
      return;
    }
    const url = new URL(request.url || "/", "http://mock");
    const artists: Record<string, object> = {
      [KNOWN_MBID]: {
        id: KNOWN_MBID,
        artistname: "Known Artist",
        Albums: [
          { Id: PICKED_GROUP, Title: "Picked Album", Type: "Album", SecondaryTypes: [] },
          { Id: OTHER_GROUP, Title: "Picked Album Live", Type: "Album", SecondaryTypes: ["Live"] },
        ],
      },
      [OTHER_MBID]: { id: OTHER_MBID, artistname: "Other Artist" },
    };
    const groups: Record<string, object> = {
      [PICKED_GROUP]: { id: PICKED_GROUP, title: "Picked Album", releases: [] },
      [OTHER_GROUP]: { id: OTHER_GROUP, title: "Picked Album Live", releases: [] },
    };
    let body: object | null = null;
    if (url.pathname.startsWith("/artist/"))
      body = artists[url.pathname.split("/")[2] ?? ""] || null;
    if (url.pathname.startsWith("/album/")) body = groups[url.pathname.split("/")[2] ?? ""] || null;
    if (url.pathname === "/search/artist") {
      body =
        url.searchParams.get("query") === "Wrongly Matched"
          ? [{ id: MATCHED_BY_NAME_MBID, artistname: "Wrongly Matched" }]
          : [];
    }
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      metadata: {
        ...settings.integrations.metadata,
        baseUrl: server.url,
        enableNarrowFallbacks: false,
      },
    },
  });
  musicRoot = await mkdtemp(path.join(tmpdir(), "aurral-mbid-override-"));
});

beforeEach(() => {
  providerAvailable = true;
  provider.clearMetadataProviderCaches();
});

afterAll(async () => {
  await server?.close();
  if (musicRoot) await rm(musicRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

let fixtureCount = 0;

function createArtist(
  name: string,
  {
    mbid = null,
    metadata = null,
  }: Pick<Parameters<typeof libraryStore.upsertLibraryArtist>[0], "mbid" | "metadata"> = {},
) {
  fixtureCount += 1;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: mbid ? `mbid:${mbid}` : libraryStore.buildFallbackIdentityKey("artist", name),
    mbid,
    name,
    metadata,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `album-${fixtureCount}`,
    artistId: artist.id,
    title: `${name} Album`,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `track-${fixtureCount}`,
    title: `${name} Track`,
    artistName: name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "readonly",
    path: `/library/${fixtureCount}.flac`,
    available: true,
  });
  return { artist, album };
}

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

const matchResult = v.looseObject({
  id: v.optional(v.number()),
  merged: v.optional(v.boolean()),
  musicbrainzName: v.optional(v.nullable(v.string())),
});

const albumMatches = v.object({
  source: v.string(),
  items: v.array(
    v.looseObject({
      id: v.string(),
      secondaryTypes: v.array(v.string()),
      libraryAlbumId: v.nullable(v.number()),
    }),
  ),
});

async function put(url: string, mbid: string | null) {
  const response = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mbid }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body: v.parse(matchResult, body) };
}

const updateMbid = (artistId: number, mbid: string | null) =>
  put(`/library/artists/${artistId}/mbid`, mbid);

const updateReleaseGroup = (albumId: number, mbid: string | null) =>
  put(`/library/albums/${albumId}/release-group`, mbid);

const albumRow = (id: number) =>
  db
    .prepare<unknown[], import("../../backend/db/rows.ts").LibraryAlbumsRow>(
      "SELECT * FROM library_albums WHERE id = ?",
    )
    .get(id);

const setAlbumMetadata = (albumId: number, metadata: object) =>
  db
    .prepare("UPDATE library_albums SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify(metadata), albumId);

const artistRow = (id: number) =>
  db
    .prepare<unknown[], import("../../backend/db/rows.ts").LibraryArtistsRow>(
      "SELECT * FROM library_artists WHERE id = ?",
    )
    .get(id)!;

test("a user can link an unmatched artist to a MusicBrainz ID", async () => {
  const { artist } = createArtist("Unmatched Artist");

  const response = await updateMbid(artist.id, KNOWN_MBID.toUpperCase());

  assert.equal(response.status, 200);
  assert.equal(response.body.musicbrainzName, "Known Artist");
  assert.equal(artistRow(artist.id).mbid, KNOWN_MBID);
  assert.equal(artistRow(artist.id).name, "Unmatched Artist");

  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'fan', 'x')",
  ).run();
  const key = artistRow(artist.id).identity_key;
  db.prepare(
    "INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at) VALUES (1, 'artist', ?, 1)",
  ).run(key);
  db.prepare(
    "INSERT INTO subsonic_ratings (user_id, entity_kind, entity_key, rating, updated_at) VALUES (1, 'artist', ?, 4, 1)",
  ).run(key);
  assert.equal((await updateMbid(artist.id, KNOWN_MBID)).status, 200);
  const marks = (table: string) =>
    db.prepare(`SELECT COUNT(*) FROM ${table} WHERE entity_key = ?`).pluck().get(key);
  assert.deepEqual([marks("subsonic_stars"), marks("subsonic_ratings")], [1, 1]);
});

test("linking to an MBID already in the library merges the albums into that artist", async () => {
  const existing = createArtist("Other Artist", { mbid: OTHER_MBID });
  const duplicate = createArtist("Other Artist Variant");
  db.prepare(
    `INSERT INTO library_release_calendar
      (release_group_mbid, artist_id, title, release_date, refreshed_at, created_at, updated_at)
     VALUES ('calendar-release', ?, 'Upcoming', '2099-01-01', 0, 0, 0)`,
  ).run(duplicate.artist.id);

  const response = await updateMbid(duplicate.artist.id, OTHER_MBID);

  assert.equal(response.body.id, existing.artist.id);
  assert.equal(response.body.merged, true);
  assert.equal(artistRow(duplicate.artist.id), undefined);
  assert.equal(
    db
      .prepare<unknown[], { artist_id: number }>(
        "SELECT artist_id FROM library_albums WHERE id = ?",
      )!
      .get(duplicate.album.id)!.artist_id,
    existing.artist.id,
  );
  assert.equal(
    db
      .prepare<unknown[], { artist_id: number }>(
        "SELECT artist_id FROM library_release_calendar WHERE release_group_mbid = 'calendar-release'",
      )
      .get()?.artist_id,
    existing.artist.id,
  );
});

test("removing an MBID never merges two artists that share a name", async () => {
  const unmatched = createArtist("Shared Name");
  const tagged = createArtist("Shared Name", { mbid: KNOWN_MBID.replace(/1$/, "9") });

  const response = await updateMbid(tagged.artist.id, null);

  assert.equal(response.status, 200);
  assert.equal(response.body.merged, false);
  assert.equal(artistRow(tagged.artist.id).mbid, null);
  assert.ok(artistRow(unmatched.artist.id));
  assert.equal(
    db
      .prepare<unknown[], { artist_id: number }>(
        "SELECT artist_id FROM library_albums WHERE id = ?",
      )!
      .get(tagged.album.id)!.artist_id,
    tagged.artist.id,
  );
});

test("clearing a wrong automatic match keeps the artist unmatched on later scans", async () => {
  const { artist } = createArtist("Wrongly Matched");
  await indexService.scanConfiguredLibrary({
    musicRoot,
    includeReadOnly: false,
  });
  assert.equal(artistRow(artist.id).mbid, MATCHED_BY_NAME_MBID);

  const response = await updateMbid(artist.id, null);
  await indexService.scanConfiguredLibrary({
    musicRoot,
    includeReadOnly: false,
  });

  assert.equal(response.status, 200);
  assert.equal(artistRow(artist.id).mbid, null);
});

test("MBID edits are rejected without changing the artist when they cannot be verified", async () => {
  const { artist } = createArtist("Unverified Artist");

  const missing = await updateMbid(artist.id, MISSING_MBID);
  const invalid = await updateMbid(artist.id, "not-an-mbid");
  providerAvailable = false;
  provider.clearMetadataProviderCaches();
  const offline = await updateMbid(artist.id, OTHER_MBID);

  assert.deepEqual([missing.status, invalid.status, offline.status], [404, 400, 503]);
  assert.equal(artistRow(artist.id).mbid, null);
});

test("the Discover lookup points to the library artist", () => {
  const indexed = createArtist("Indexed Only Artist", { mbid: LINKED_MBID });

  const indexedLookup = getArtistLibraryLookup(LINKED_MBID);
  const missingLookup = getArtistLibraryLookup(MISSING_MBID);

  assert.equal(indexedLookup.exists, true);
  assert.equal(indexedLookup.libraryArtistId, String(indexed.artist.id));
  assert.equal(missingLookup.libraryArtistId, null);
});

test("a hand-picked release group keeps an untagged album's files through full rescans, after merging into an album with another title", async () => {
  const root = path.join(musicRoot, "hand-picked");
  const filePath = await writeFlacFixture(
    path.join(root, "Hand Artist", "Folder Title", "01 Song.flac"),
    { artist: "Hand Artist", album: "Folder Title", title: "Song", track: "1" },
  );
  await scanMusicRoot({ rootPath: root, source: "readonly" });
  const fileAlbum = () =>
    db
      .prepare<[string], number>("SELECT album_id FROM library_media_files WHERE path = ?")
      .pluck()
      .get(filePath);
  const folderAlbum = fileAlbum()!;
  const target = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${PICKED_GROUP}`,
    releaseGroupMbid: PICKED_GROUP,
    artistId: albumRow(folderAlbum)!.artist_id,
    title: "Picked Album",
  });

  const response = await updateReleaseGroup(folderAlbum, PICKED_GROUP);
  await scanMusicRoot({ rootPath: root, source: "readonly", force: true });

  assert.equal(response.status, 200);
  assert.deepEqual([response.body.id, response.body.merged], [target.id, true]);
  assert.equal(fileAlbum(), target.id);
  assert.equal(albumRow(target.id)?.title, "Picked Album");
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM library_albums WHERE title = 'Folder Title'").pluck().get(),
    0,
  );
});

test("an album whose match was removed by hand stays out of automatic matching", async () => {
  const { album } = createArtist("Unmatched Album Artist", { mbid: ALBUM_ARTIST_MBID });
  const untagged = () =>
    libraryStore.getUntaggedLibraryAlbums({ retry: true }).map((entry) => entry.id);
  assert.ok(untagged().includes(album.id));

  const picked = await updateReleaseGroup(album.id, OTHER_GROUP);
  const removed = await updateReleaseGroup(album.id, null);

  assert.deepEqual([picked.status, removed.status], [200, 200]);
  assert.equal(albumRow(album.id)?.release_group_mbid, null);
  assert.ok(!untagged().includes(album.id));
});

test("album matches are rejected without changing the album when they cannot be applied", async () => {
  const { album } = createArtist("Refused Album Artist");
  const tagged = createArtist("Tagged Album Artist");
  setAlbumMetadata(tagged.album.id, { tags: { musicbrainz_releasegroupid: OTHER_GROUP } });

  const statuses = [
    (await updateReleaseGroup(album.id, MISSING_GROUP)).status,
    (await updateReleaseGroup(album.id, "not-an-mbid")).status,
    (await updateReleaseGroup(tagged.album.id, OTHER_GROUP)).status,
  ];

  assert.deepEqual(statuses, [404, 400, 409]);
  assert.deepEqual(
    [album, tagged.album].map((entry) => albumRow(entry.id)?.release_group_mbid),
    [null, null],
  );
});

test("an album's matches are its artist's releases, marking the one the Library already has", async () => {
  const { artist, album } = createArtist("Discography Artist", { mbid: KNOWN_MBID });
  const owned = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${OTHER_GROUP}`,
    releaseGroupMbid: OTHER_GROUP,
    artistId: artist.id,
    title: "Picked Album Live",
  });

  const response = await app.request(`/library/albums/${album.id}/matches`);
  const json: unknown = await response.json();
  const body = v.parse(albumMatches, json);

  assert.equal(body.source, "discography");
  assert.deepEqual(
    body.items.map((item) => [item.id, item.secondaryTypes]),
    [
      [PICKED_GROUP, []],
      [OTHER_GROUP, ["Live"]],
    ],
  );
  assert.equal(body.items[1]?.libraryAlbumId, owned.id);
});
