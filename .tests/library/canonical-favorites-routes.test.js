import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";

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
  const secondTrack = upsertLibraryTrack({
    identityKey: "favorite-track-two",
    mbid: "44444444-4444-4444-8444-444444444444",
    title: "Favorite Track Two",
    artistName: artist.name,
  });
  linkLibraryAlbumTrack({ albumId: album.id, trackId: secondTrack.id, trackNumber: 2 });
  upsertLibraryMediaFile({
    trackId: secondTrack.id,
    source: "aurral",
    path: "/library/Favorite Artist/Favorite Album/02 Favorite Track Two.flac",
    format: "flac",
    available: false,
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
  const response = new Writable({
    write(chunk, _encoding, callback) {
      this.chunks.push(chunk.toString());
      callback();
    },
  });
  response.chunks = [];
  response.on("finish", () => {
    if (response.chunks.length > 0) response.body = JSON.parse(response.chunks.join(""));
  });
  Object.assign(response, {
    body: null,
    statusCode: 200,
    contentType: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = JSON.parse(value);
      return this;
    },
  });
  return response;
}

test("native favorites return changed identities and reuse Subsonic star identity", () => {
  const target = `artist:${encodeURIComponent(artist.identity_key)}`;
  const postResponse = responseFor();
  getRoute("POST /favorites")(
    { user, body: { ids: [target], starred: true } },
    postResponse,
  );

  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(postResponse.body.changedIds, [target]);
  assert.equal(postResponse.body.library, undefined);

  const getResponse = responseFor();
  getRoute("GET /favorites")({ user }, getResponse);
  assert.deepEqual(getResponse.body.artist.map((entry) => entry.id), [target]);
});

test("native favorites include the canonical favorite subset", () => {
  const response = responseFor();
  getRoute("GET /favorites")({ user }, response);

  assert.deepEqual(response.body.library.artists.map((entry) => entry.name), ["Favorite Artist"]);
  assert.deepEqual(response.body.library.albums.map((entry) => entry.title), ["Favorite Album"]);
  assert.deepEqual(response.body.library.tracks.map((entry) => entry.title), [
    "Favorite Track",
    "Favorite Track Two",
  ]);
  assert.equal(response.body.library.tracks[0].files[0].path, undefined);
});

test("canonical library pages return bounded collection responses", () => {
  const response = responseFor();
  getRoute("GET /canonical")(
    { user, query: { kind: "tracks", page: "1", pageSize: "1", availableOnly: "false" } },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.kind, "tracks");
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 1);
  assert.equal(response.body.total, 3);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].artistName, "Favorite Artist");
  assert.equal(response.body.albums[0].trackCount, 2);
  assert.equal(response.body.albums[0].availableTrackCount, 1);
  assert.equal(response.body.hasMore, true);
  assert.equal(response.body.items[0].files[0].path, undefined);

  const availableResponse = responseFor();
  getRoute("GET /canonical")(
    { user, query: { kind: "albums", page: "1", pageSize: "1", availableOnly: "true" } },
    availableResponse,
  );
  assert.equal(availableResponse.body.items[0].trackCount, 2);
  assert.equal(availableResponse.body.items[0].availableTrackCount, 1);

  const artistResponse = responseFor();
  getRoute("GET /canonical")(
    { user, query: { kind: "artists", page: "1", pageSize: "1" } },
    artistResponse,
  );
  assert.equal(artistResponse.body.items[0].userFavorite, true);
});

test("canonical library rejects unbounded requests", () => {
  const response = responseFor();
  getRoute("GET /canonical")({ user, query: { kind: "tracks" } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "kind and pageSize (1-100) are required");
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
