import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { hashPassword }, { indexLidarrLibrary }, { flowPlaylistConfig }, { downloadTracker }] =
  await setupIsolatedBackend(
    "subsonic-canonical",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/middleware/passwordHash.js",
    "backend/services/libraryLidarrIndexer.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );

let aurral;
let fixtureRoot;
let fixturePath;

function subsonicUrl(method, params = {}) {
  const query = new URLSearchParams({
    u: "alice",
    p: "password123",
    v: "1.16.1",
    c: "canonical-test",
    f: "json",
    ...params,
  });
  return `http://127.0.0.1:${aurral.port}/rest/${method}.view?${query}`;
}

async function request(method, params = {}, options = {}) {
  const response = await fetch(subsonicUrl(method, params), options);
  const contentType = response.headers.get("content-type") || "";
  return {
    response,
    contentType,
    body: await response.text(),
  };
}

function responseJson(result) {
  return JSON.parse(result.body)["subsonic-response"];
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { general: { authUser: "alice", authPassword: "password123" } },
    security: { localNetworkBypass: { enabled: false } },
    onboardingComplete: true,
  });
  userOps.createUser("alice", hashPassword("password123"), "admin");

  fixtureRoot = await mkdtemp(path.join(isolatedState.baseDir, "media-"));
  fixturePath = path.join(fixtureRoot, "Canonical Artist", "Canonical Album", "01 Canonical Song.flac");
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, "0123456789");
  await indexLidarrLibrary({
    client: {
      isConfigured: () => true,
      request: async () => [{
        id: 1,
        artistName: "Canonical Artist",
        sortName: "Canonical Artist",
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
      }],
      getAllAlbums: async () => [{
        id: 2,
        artistId: 1,
        title: "Canonical Album",
        foreignAlbumId: "22222222-2222-4222-8222-222222222222",
      }],
      getTracksByAlbumId: async () => [{
        id: 3,
        albumId: 2,
        title: "Canonical Song",
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

  const flow = flowPlaylistConfig.createFlow({ name: "Canonical Flow", size: 1 });
  const jobId = downloadTracker.addJob({
    artistName: "Flow Artist",
    albumName: "Flow Album",
    trackName: "Flow Song",
    durationMs: 1000,
  }, flow.id);
  downloadTracker.setDone(jobId, fixturePath);
  aurral = await startServerProcess();
});

test.after(async () => {
  await aurral?.stop();
  await rm(fixtureRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("browses canonical artists, albums, and songs with stable protocol IDs", async () => {
  const user = responseJson(await request("getUser")).user;
  assert.equal(user.username, "alice");
  assert.equal(user.adminRole, true);
  assert.equal(user.streamRole, true);

  const artistsResult = responseJson(await request("getArtists"));
  const artist = artistsResult.artists.index[0].artist[0];
  assert.match(artist.id, /^artist:/);
  assert.equal(artistsResult.artists.ignoredArticles, "The El La Los Las Le Les");
  const artistsXml = await request("getArtists", { f: "xml" });
  assert.match(artistsXml.body, /<artists[^>]*><index name="C"><artist id="artist:/);

  const license = responseJson(await request("getLicense"));
  assert.equal(license.license.valid, true);
  const indexes = responseJson(await request("getIndexes"));
  assert.equal(typeof indexes.indexes.lastModified, "number");
  const albumList = responseJson(await request("getAlbumList2", { type: "newest", size: 10 }));
  assert.equal(albumList.albumList2.album[0].title, "Canonical Album");
  assert.deepEqual(responseJson(await request("getGenres")).genres.genre, []);
  assert.deepEqual(responseJson(await request("getStarred")).starred, {
    album: [],
    artist: [],
    song: [],
  });

  const albumResult = responseJson(await request("getArtist", { id: artist.id }));
  const album = albumResult.artist.album[0];
  assert.match(album.id, /^album:/);
  assert.deepEqual(responseJson(await request("getArtistInfo", { id: artist.id })).artistInfo.similarArtist, []);
  assert.equal(responseJson(await request("getTopSongs", { artist: "Canonical Artist" })).topSongs.song[0].title, "Canonical Song");

  const songResult = responseJson(await request("getAlbum", { id: album.id }));
  const song = songResult.album.song[0];
  assert.match(song.id, /^song:/);
  assert.equal(responseJson(await request("getSong", { id: song.id })).song.title, "Canonical Song");
  assert.equal(song.contentType, "audio/flac");
  assert.equal(song.path, song.id);
  assert.deepEqual(song.artists, [{ id: artist.id, name: "Canonical Artist" }]);

  const missingArtist = await request("getTopSongs", { artist: "   " });
  assert.equal(responseJson(missingArtist).error.code, 10);
});

test("accepts Subsonic token auth for the configured Aurral account", async () => {
  const salt = "canonical-salt";
  const token = createHash("md5").update(`password123${salt}`).digest("hex");
  const result = responseJson(await request("getUser", { p: "", t: token, s: salt }));
  assert.equal(result.user.username, "alice");
});

test("searches canonical records and exposes flow entries as playlist items", async () => {
  const search = responseJson(await request("search3", { query: "Canonical" }));
  assert.equal(search.searchResult3.artist[0].name, "Canonical Artist");
  assert.equal(search.searchResult3.song[0].title, "Canonical Song");

  const playlists = responseJson(await request("getPlaylists"));
  const flow = playlists.playlists.playlist.find((entry) => entry.name === "Canonical Flow");
  assert.ok(flow);
  const playlist = responseJson(await request("getPlaylist", { id: flow.id }));
  assert.equal(playlist.playlist.entry[0].title, "Flow Song");
  assert.equal(playlist.playlist.public, false);
});

test("streams canonical files with full and range responses", async () => {
  const artist = responseJson(await request("getArtists")).artists.index[0].artist[0];
  const album = responseJson(await request("getArtist", { id: artist.id })).artist.album[0];
  const song = responseJson(await request("getAlbum", { id: album.id })).album.song[0];

  const full = await request("stream", { id: song.id });
  assert.equal(full.response.status, 200);
  assert.equal(full.body, "0123456789");
  assert.equal(full.response.headers.get("accept-ranges"), "bytes");

  const range = await request("stream", { id: song.id }, { headers: { Range: "bytes=3-5" } });
  assert.equal(range.response.status, 206);
  assert.equal(range.body, "345");
  assert.equal(range.response.headers.get("content-range"), "bytes 3-5/10");

  const suffix = await request("stream", { id: song.id }, { headers: { Range: "bytes=-3" } });
  assert.equal(suffix.response.status, 206);
  assert.equal(suffix.body, "789");

  const invalid = await request("stream", { id: song.id }, { headers: { Range: "not-a-range" } });
  assert.equal(invalid.response.status, 200);
  assert.equal(invalid.body, "0123456789");

  const unsatisfiable = await request(
    "stream",
    { id: song.id },
    { headers: { Range: "bytes=99-" } },
  );
  assert.equal(unsatisfiable.response.status, 416);
});

test("streams canonical files through the authenticated native route", async () => {
  const login = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "password123" }),
  });
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const canonical = await fetch(
    `http://127.0.0.1:${aurral.port}/api/library/canonical?source=lidarr&availableOnly=true`,
    { headers },
  );
  const library = await canonical.json();
  const albumId = library.tracks[0].albums[0].albumId;
  const tracks = await fetch(
    `http://127.0.0.1:${aurral.port}/api/library/tracks?readPath=canonical&source=lidarr&albumId=${albumId}`,
    { headers },
  );
  const track = (await tracks.json())[0];
  const stream = await fetch(
    `http://127.0.0.1:${aurral.port}/api${track.streamPath}`,
    { headers },
  );
  assert.equal(stream.status, 200);
  assert.equal(await stream.text(), "0123456789");

  const unauthorized = await fetch(
    `http://127.0.0.1:${aurral.port}/api${track.streamPath}`,
  );
  assert.equal(unauthorized.status, 401);
});

test("returns missing files and stale IDs without exposing filesystem paths", async () => {
  const artist = responseJson(await request("getArtists")).artists.index[0].artist[0];
  const album = responseJson(await request("getArtist", { id: artist.id })).artist.album[0];
  const song = responseJson(await request("getAlbum", { id: album.id })).album.song[0];
  await rm(fixturePath);

  const missing = await request("stream", { id: song.id });
  assert.equal(missing.response.status, 404);

  const stale = await request("getSong", { id: "song:missing-identity" });
  assert.equal(responseJson(stale).error.code, 70);
  assert.equal(stale.body.includes(fixturePath), false);
});

test("keeps canonical protocol IDs and flow entries after restart", async () => {
  const before = responseJson(await request("getArtists")).artists.index[0].artist[0].id;
  await aurral.stop();
  aurral = await startServerProcess();
  const after = responseJson(await request("getArtists")).artists.index[0].artist[0].id;
  assert.equal(after, before);
  assert.equal(responseJson(await request("getPlaylists")).playlists.playlist[0].name, "Canonical Flow");
});

test("returns the canonical artwork redirect contract", async () => {
  const artist = responseJson(await request("getArtists")).artists.index[0].artist[0];
  dbOps.setImage("11111111-1111-4111-8111-111111111111", "https://example.com/cover.jpg");
  const result = await request("getCoverArt", { id: artist.id }, { redirect: "manual" });
  assert.equal(result.response.status, 302);
  assert.match(result.response.headers.get("location"), /image-proxy/);
});
