import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, libraryStore, provider, indexService] =
  await setupIsolatedBackend(
    "artist-mbid-override",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/libraryMediaStore.js",
    "backend/services/providers/brainzmashProvider.js",
    "backend/services/libraryIndexService.js",
  );

const { registerArtists } = await import("../../backend/routes/library/handlers/artists.js");

const KNOWN_MBID = "55555555-5555-4555-8555-555555555551";
const OTHER_MBID = "55555555-5555-4555-8555-555555555552";
const MISSING_MBID = "55555555-5555-4555-8555-555555555553";
const MATCHED_BY_NAME_MBID = "55555555-5555-4555-8555-555555555554";

let providerAvailable = true;
let server;
let musicRoot;

test.before(async () => {
  resetDatabase(db);
  server = await createMockHttpServer((request, response) => {
    if (!providerAvailable) {
      response.writeHead(500);
      response.end();
      return;
    }
    const url = new URL(request.url, "http://mock");
    const artists = {
      [KNOWN_MBID]: { id: KNOWN_MBID, artistname: "Known Artist" },
      [OTHER_MBID]: { id: OTHER_MBID, artistname: "Other Artist" },
    };
    let body = null;
    if (url.pathname.startsWith("/artist/")) body = artists[url.pathname.split("/")[2]] || null;
    if (url.pathname === "/search/artist") {
      body = url.searchParams.get("query") === "Wrongly Matched"
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
      metadata: { ...settings.integrations.metadata, baseUrl: server.url, enableNarrowFallbacks: false },
    },
  });
  musicRoot = await mkdtemp(path.join(tmpdir(), "aurral-mbid-override-"));
});

test.beforeEach(() => {
  providerAvailable = true;
  provider.clearMetadataProviderCaches();
});

test.after(async () => {
  await server?.close();
  if (musicRoot) await rm(musicRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

let fixtureCount = 0;
function createArtist(name, { mbid = null, metadata = null } = {}) {
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

function updateMbid(artistId, mbid) {
  let handler;
  registerArtists({
    get() {},
    post() {},
    delete() {},
    put(routePath, ...handlers) {
      if (routePath === "/canonical/artists/:id/mbid") handler = handlers.at(-1);
    },
  });
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  return handler({ params: { id: String(artistId) }, body: { mbid } }, response).then(() => response);
}

const artistRow = (id) => db.prepare("SELECT * FROM library_artists WHERE id = ?").get(id);

test("a user can link an unmatched artist to a MusicBrainz ID", async () => {
  const { artist } = createArtist("Unmatched Artist");

  const response = await updateMbid(artist.id, KNOWN_MBID.toUpperCase());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.musicbrainzName, "Known Artist");
  assert.equal(artistRow(artist.id).mbid, KNOWN_MBID);
  assert.equal(artistRow(artist.id).name, "Unmatched Artist");
});

test("linking to an MBID already in the library merges the albums into that artist", async () => {
  const existing = createArtist("Other Artist", { mbid: OTHER_MBID });
  const duplicate = createArtist("Other Artist Variant");

  const response = await updateMbid(duplicate.artist.id, OTHER_MBID);

  assert.equal(response.body.id, existing.artist.id);
  assert.equal(response.body.merged, true);
  assert.equal(artistRow(duplicate.artist.id), undefined);
  assert.equal(
    db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(duplicate.album.id).artist_id,
    existing.artist.id,
  );
});

test("clearing a wrong automatic match keeps the artist unmatched on later scans", async () => {
  const { artist } = createArtist("Wrongly Matched");
  await indexService.scanConfiguredLibrary({ musicRoot, includeLidarr: false });
  assert.equal(artistRow(artist.id).mbid, MATCHED_BY_NAME_MBID);

  const response = await updateMbid(artist.id, null);
  await indexService.scanConfiguredLibrary({ musicRoot, includeLidarr: false });

  assert.equal(response.statusCode, 200);
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
    [missing.statusCode, invalid.statusCode, lidarrManaged.statusCode, offline.statusCode],
    [404, 400, 409, 503],
  );
  assert.equal(artistRow(artist.id).mbid, null);
  assert.equal(artistRow(lidarr.artist.id).mbid, null);
});
