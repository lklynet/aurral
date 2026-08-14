import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, libraryService, libraryStore] =
  await setupIsolatedBackend(
    "canonical-favorites-route",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/subsonicLibraryService.js",
    "backend/services/libraryMediaStore.js",
  );

const { registerCanonical } = await import(
  "../../backend/routes/library/handlers/canonical.js"
);
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

let user;
let artist;

test.before(() => {
  resetDatabase(db);
  user = userOps.getUserById(userOps.createUser("native", "hash").id);
  artist = upsertLibraryArtist({
    identityKey: "favorite-artist",
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "Favorite Artist",
    metadata: { genres: ["Indie Rock"] },
  });
  const album = upsertLibraryAlbum({
    identityKey: "favorite-album",
    mbid: "22222222-2222-4222-8222-222222222222",
    artistId: artist.id,
    title: "Favorite Album",
    albumArtist: artist.name,
  });
  const track = upsertLibraryTrack({
    identityKey: "favorite-track",
    mbid: "33333333-3333-4333-8333-333333333333",
    title: "Favorite Track",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: track.id,
    source: "aurral",
    path: "/library/Favorite Artist/Favorite Album/01 Favorite Track.flac",
    format: "flac",
    available: true,
  });
  const otherArtist = upsertLibraryArtist({
    identityKey: "other-artist",
    name: "Other Artist",
    metadata: { genres: ["Jazz"] },
  });
  const otherAlbum = upsertLibraryAlbum({
    identityKey: "other-album",
    artistId: otherArtist.id,
    title: "Other Album",
    albumArtist: otherArtist.name,
  });
  const otherTrack = upsertLibraryTrack({
    identityKey: "other-track",
    title: "Other Track",
    artistName: otherArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: otherAlbum.id, trackId: otherTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: otherTrack.id,
    source: "aurral",
    path: "/library/Other Artist/Other Album/01 Other Track.flac",
    format: "flac",
    available: true,
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function getRoute(path) {
  const routes = new Map();
  registerCanonical({
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers.at(-1));
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers.at(-1));
    },
  });
  return routes.get(path);
}

function responseFor() {
  return {
    body: null,
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("native favorites reuse Subsonic star identity and return current favorites", () => {
  const target = `artist:${encodeURIComponent(artist.identity_key)}`;
  const postResponse = responseFor();
  getRoute("POST /favorites")(
    { user, body: { ids: [target], starred: true } },
    postResponse,
  );

  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.body.artist[0].id, target);

  const getResponse = responseFor();
  getRoute("GET /favorites")({ user }, getResponse);
  assert.deepEqual(getResponse.body.artist.map((entry) => entry.id), [target]);
});

test("native favorites include the canonical favorite subset", () => {
  const response = responseFor();
  getRoute("GET /favorites")({ user }, response);

  assert.deepEqual(response.body.library.artists.map((entry) => entry.name), ["Favorite Artist"]);
  assert.deepEqual(response.body.library.albums.map((entry) => entry.title), ["Favorite Album"]);
  assert.deepEqual(response.body.library.tracks.map((entry) => entry.title), ["Favorite Track"]);
});

test("canonical library pages return bounded collection responses", () => {
  const response = responseFor();
  getRoute("GET /canonical")(
    { user, query: { kind: "tracks", page: "1", pageSize: "1" } },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.kind, "tracks");
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 1);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].artistName, "Favorite Artist");

  const artistResponse = responseFor();
  getRoute("GET /canonical")(
    { user, query: { kind: "artists", page: "1", pageSize: "1" } },
    artistResponse,
  );
  assert.equal(artistResponse.body.items[0].userFavorite, true);
});

test("native favorites rejects unknown targets without changing stars", () => {
  const response = responseFor();
  getRoute("POST /favorites")(
    { user, body: { ids: ["album:missing"], starred: true } },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Invalid favorite target");
  assert.equal(libraryService.getStarred(user).artist.length, 1);
});

test("canonical pages filter, count, and paginate in the read query", () => {
  const response = responseFor();
  getRoute("GET /canonical")(
    {
      query: {
        kind: "albums",
        query: "Favorite",
        genre: "indie rock",
        page: "1",
        pageSize: "1",
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.hasMore, false);
  assert.equal(response.body.items[0].title, "Favorite Album");
});
