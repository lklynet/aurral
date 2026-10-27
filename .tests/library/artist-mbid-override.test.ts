import { requireFixture } from "../playlists/fixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, beforeAll, beforeEach, afterAll, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, libraryStore, provider, indexService] =
  await setupIsolatedBackend(
    "artist-mbid-override",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/providers/brainzmashProvider.ts"),
    () => import("../../backend/services/libraryIndexService.ts"),
  );

const { api } = await import("../../backend/routes/api.ts");
const { getArtistLibraryLookup } = await import("../../backend/routes/library/handlers/misc.ts");
const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");

const KNOWN_MBID = "55555555-5555-4555-8555-555555555551";
const OTHER_MBID = "55555555-5555-4555-8555-555555555552";
const MISSING_MBID = "55555555-5555-4555-8555-555555555553";
const MATCHED_BY_NAME_MBID = "55555555-5555-4555-8555-555555555554";
const LINKED_MBID = "55555555-5555-4555-8555-555555555555";
const LIDARR_MBID = "55555555-5555-4555-8555-555555555556";

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
    const artists: Record<string, { id: string; artistname: string }> = {
      [KNOWN_MBID]: { id: KNOWN_MBID, artistname: "Known Artist" },
      [OTHER_MBID]: { id: OTHER_MBID, artistname: "Other Artist" },
    };
    let body: { id: string; artistname: string } | { id: string; artistname: string }[] | null =
      null;
    if (url.pathname.startsWith("/artist/")) body = artists[url.pathname.split("/")[2]] || null;
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
const lidarrConnected = { isConfigured: () => true };

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
    source: "lidarr",
    path: `/library/${fixtureCount}.flac`,
    available: true,
  });
  return { artist, album };
}

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

async function updateMbid(artistId: number, mbid: string | null) {
  const response = await app.request(`/library/canonical/artists/${artistId}/mbid`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mbid }),
  });
  return { status: response.status, body: await response.json() };
}

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
    requireFixture(db)
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
    requireFixture(db)
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
    includeLidarr: false,
    lidarrClient: lidarrConnected,
  });
  assert.equal(artistRow(artist.id).mbid, MATCHED_BY_NAME_MBID);

  const response = await updateMbid(artist.id, null);
  await indexService.scanConfiguredLibrary({
    musicRoot,
    includeLidarr: false,
    lidarrClient: lidarrConnected,
  });

  assert.equal(response.status, 200);
  assert.equal(artistRow(artist.id).mbid, null);
});

test("MBID edits are rejected without changing the artist when they cannot be verified", async () => {
  const { artist } = createArtist("Unverified Artist");
  const lidarr = createArtist("Lidarr Artist", { metadata: { id: 42 } });

  const missing = await updateMbid(artist.id, MISSING_MBID);
  const invalid = await updateMbid(artist.id, "not-an-mbid");
  const lidarrManaged = await updateMbid(lidarr.artist.id, KNOWN_MBID);
  providerAvailable = false;
  provider.clearMetadataProviderCaches();
  const offline = await updateMbid(artist.id, OTHER_MBID);

  assert.deepEqual(
    [missing.status, invalid.status, lidarrManaged.status, offline.status],
    [404, 400, 409, 503],
  );
  assert.equal(artistRow(artist.id).mbid, null);
  assert.equal(artistRow(lidarr.artist.id).mbid, null);
});

test("the Discover lookup points to the library artist whether or not Lidarr manages it", async () => {
  const indexed = createArtist("Indexed Only Artist", { mbid: LINKED_MBID });
  const managed = createArtist("Lidarr Managed Artist", {
    mbid: LIDARR_MBID,
    metadata: { id: 4242 },
  });
  const lidarrArtist = {
    id: 4242,
    foreignArtistId: LIDARR_MBID,
    artistName: "Lidarr Managed Artist",
  };
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getArtistByMbid").mockImplementation(async (mbid) =>
    mbid === LIDARR_MBID ? lidarrArtist : null,
  );
  vi.spyOn(lidarrClient, "request").mockImplementation(async () => []);

  const indexedLookup = await getArtistLibraryLookup(LINKED_MBID);
  const managedLookup = await getArtistLibraryLookup(LIDARR_MBID);
  const missingLookup = await getArtistLibraryLookup(MISSING_MBID);

  assert.equal(indexedLookup.exists, false);
  assert.equal(indexedLookup.libraryArtistId, String(indexed.artist.id));
  assert.equal(managedLookup.exists, true);
  assert.equal(managedLookup.libraryArtistId, String(managed.artist.id));
  assert.equal(missingLookup.libraryArtistId, null);
});
