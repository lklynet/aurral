import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { hashPassword }, { indexLidarrLibrary }, { flowPlaylistConfig }, { downloadTracker }] =
  await setupIsolatedBackend(
    "subsonic-openapi",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/middleware/passwordHash.js",
    "backend/services/libraryLidarrIndexer.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );

const spec = JSON.parse(
  await readFile(new URL("./openapi/opensubsonic-openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const validators = new Map();

function validatorFor(method) {
  if (!validators.has(method)) {
    const operation = spec.paths[`/rest/${method}`]?.get;
    assert.ok(operation, `spec has no GET /rest/${method}`);
    let response = operation.responses["200"];
    if (response.$ref) {
      response = spec.components.responses[response.$ref.replace("#/components/responses/", "")];
    }
    const schema = response.content["application/json"].schema;
    validators.set(method, ajv.compile({ ...schema, components: spec.components }));
  }
  return validators.get(method);
}

let aurral;
let fixtureRoot;

function subsonicUrl(method, params = {}) {
  const query = new URLSearchParams({ u: "alice", p: "password123", v: "1.16.1", c: "openapi-test", f: "json" });
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : [value]) query.append(key, entry);
  }
  return `http://127.0.0.1:${aurral.port}/rest/${method}.view?${query}`;
}

async function call(method, params) {
  const response = await fetch(subsonicUrl(method, params));
  assert.equal(response.status, 200, `${method} HTTP status`);
  return JSON.parse(await response.text());
}

async function assertValid(method, params = {}) {
  const body = await call(method, params);
  const validate = validatorFor(method);
  assert.ok(
    validate(body),
    `${method} response does not match the OpenSubsonic schema:\n${ajv.errorsText(validate.errors, { separator: "\n" })}\n${JSON.stringify(body).slice(0, 2000)}`,
  );
  return body["subsonic-response"];
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { general: { authUser: "alice", authPassword: "password123" } },
    security: { localNetworkBypass: { enabled: false } },
    onboardingComplete: true,
  });
  const alice = userOps.createUser("alice", hashPassword("password123"), "admin");

  fixtureRoot = await mkdtemp(path.join(isolatedState.baseDir, "media-"));
  const fixturePath = path.join(fixtureRoot, "Schema Artist", "Schema Album", "01 Schema Song.flac");
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, "0123456789");
  await indexLidarrLibrary({
    client: {
      isConfigured: () => true,
      request: async () => [{
        id: 1,
        artistName: "Schema Artist",
        sortName: "Schema Artist",
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
        genres: ["Rock"],
      }],
      getAllAlbums: async () => [{
        id: 2,
        artistId: 1,
        title: "Schema Album",
        foreignAlbumId: "22222222-2222-4222-8222-222222222222",
      }],
      getTracksByAlbumId: async () => [{
        id: 3,
        albumId: 2,
        title: "Schema Song",
        trackNumber: 1,
        duration: 10,
        foreignRecordingId: "33333333-3333-4333-8333-333333333333",
        trackFileId: 4,
      }],
      getTrackFilesByAlbumId: async () => [{
        id: 4,
        path: fixturePath,
        trackIds: [3],
        duration: 10,
        mediaInfo: { audioFormat: "FLAC" },
      }],
      getRootFolders: async () => [{ path: fixtureRoot }],
    },
  });

  const playlist = flowPlaylistConfig.createSharedPlaylist({
    name: "Schema Playlist",
    ownerUserId: alice.id,
    tracks: [{ artistName: "Schema Artist", albumName: "Schema Album", trackName: "Schema Song", durationMs: 10_000 }],
  });
  const jobId = downloadTracker.addJob({
    artistName: "Schema Artist",
    albumName: "Schema Album",
    trackName: "Schema Song",
    trackMbid: "33333333-3333-4333-8333-333333333333",
    durationMs: 10_000,
  }, playlist.id);
  downloadTracker.setDone(jobId, fixturePath, "Schema Album");

  aurral = await startServerProcess({ extraEnv: { CORS_ORIGIN: "" } });
});

test.after(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("the schema rejects a malformed response", () => {
  const validate = validatorFor("getSong");
  assert.equal(validate({ "subsonic-response": { status: "ok", version: "1.16.1" } }), false);
});

test("system and browsing responses match the OpenSubsonic schema", async () => {
  await assertValid("ping");
  await assertValid("getLicense");
  await assertValid("getOpenSubsonicExtensions");
  await assertValid("getMusicFolders");
  await assertValid("getIndexes");
  await assertValid("getGenres");
  await assertValid("getUser", { username: "alice" });

  const artists = await assertValid("getArtists");
  const artistId = artists.artists.index[0].artist[0].id;
  const artist = await assertValid("getArtist", { id: artistId });
  const albumId = artist.artist.album[0].id;
  const album = await assertValid("getAlbum", { id: albumId });
  const songId = album.album.song[0].id;
  await assertValid("getSong", { id: songId });
  await assertValid("getMusicDirectory", { id: "1" });
  await assertValid("getMusicDirectory", { id: artistId });
  await assertValid("getMusicDirectory", { id: albumId });
  await assertValid("getArtistInfo", { id: artistId });
  await assertValid("getArtistInfo2", { id: artistId });
  await assertValid("getAlbumInfo", { id: albumId });
  await assertValid("getAlbumInfo2", { id: albumId });
  await assertValid("getSimilarSongs", { id: songId });
  await assertValid("getSimilarSongs2", { id: songId });
  await assertValid("getTopSongs", { artist: "Schema Artist" });
  await assertValid("getTopSongs", { id: artistId });
  await assertValid("getLyrics", { artist: "Schema Artist", title: "Schema Song" });
  await assertValid("getInternetRadioStations");
  await assertValid("getPodcasts");
});

test("list, search, playlist and annotation responses match the OpenSubsonic schema", async () => {
  await assertValid("getAlbumList2", { type: "newest", size: 10 });
  await assertValid("getAlbumList2", { type: "alphabeticalByArtist", size: 10 });
  await assertValid("getSongsByGenre", { genre: "Rock" });
  await assertValid("search3", { query: "Schema" });
  await assertValid("search3", { query: "" });
  await assertValid("search2", { query: "Schema" });

  const artists = await assertValid("getArtists");
  const artistId = artists.artists.index[0].artist[0].id;
  const album = (await assertValid("getArtist", { id: artistId })).artist.album[0];
  const songId = (await assertValid("getAlbum", { id: album.id })).album.song[0].id;

  await assertValid("star", { id: songId, albumId: album.id, artistId });
  await assertValid("getStarred2");
  await assertValid("getSong", { id: songId });
  await assertValid("unstar", { id: songId, albumId: album.id, artistId });
  await assertValid("scrobble", { id: songId, submission: "true" });

  const playlists = await assertValid("getPlaylists");
  const playlistId = playlists.playlists.playlist[0].id;
  await assertValid("getPlaylist", { id: playlistId });
  const created = await assertValid("createPlaylist", { name: "Schema Created", songId });
  const createdId = created.playlist.id;
  await assertValid("updatePlaylist", { playlistId: createdId, name: "Schema Renamed" });
  await assertValid("deletePlaylist", { id: createdId });
});

test("error responses match the OpenSubsonic schema", async () => {
  await assertValid("getSong", { id: "song:missing" });
  await assertValid("getArtist", { id: "artist:missing" });
  await assertValid("ping", { p: "wrong-password" });
  await assertValid("getTopSongs", { artist: "" });
  const token = await fetch(`http://127.0.0.1:${aurral.port}/rest/ping.view?u=alice&t=deadbeef&s=salt&v=1.16.1&c=openapi-test&f=json`);
  const body = JSON.parse(await token.text());
  assert.ok(validatorFor("ping")(body), ajv.errorsText(validatorFor("ping").errors));
  assert.equal(body["subsonic-response"].error.code, 41);
});
