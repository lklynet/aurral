import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { hashPassword }, { indexLidarrLibrary }, { flowPlaylistConfig }, { downloadTracker }, { weeklyFlowWorker }, { updateSharedPlaylist }, { resolveArtworkUrl, createSubsonicPlaylist, star }, { warmImageProxy }, { playlistManager }] =
  await setupIsolatedBackend(
    "subsonic-canonical",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/middleware/passwordHash.js",
    "backend/services/libraryLidarrIndexer.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/subsonicLibraryService.js",
  "backend/services/imageProxyService.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

let aurral;
let authToken;
let fixtureRoot;
let fixturePath;
let sharedPlaylist;
let syncedFavoritePlaylist;
let syncedFavoriteSourcePath;
let syncedFavoriteSourceJobId;
let canonicalFavoritePlaylist;
let canonicalFavoriteJobId;

function subsonicUrl(method, params = {}) {
  const query = new URLSearchParams({
    u: "alice",
    p: "password123",
    v: "1.16.1",
    c: "canonical-test",
    f: "json",
    ...params,
  });
  for (const [key, value] of Object.entries(params)) {
    if (!Array.isArray(value)) continue;
    query.delete(key);
    for (const entry of value) query.append(key, entry);
  }
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

async function apiFetch(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${aurral.port}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
}

function responseJson(result) {
  return JSON.parse(result.body)["subsonic-response"];
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Subsonic mutation");
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
        genres: ["Rock"],
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
    albumMbid: "flow-album-mbid",
    trackName: "Flow Song",
    durationMs: 1000,
  }, flow.id);
  downloadTracker.setDone(jobId, fixturePath);
  sharedPlaylist = flowPlaylistConfig.createSharedPlaylist({
    name: "Canonical Shared",
    ownerUserId: alice.id,
    tracks: [{
      artistName: "Flow Artist",
      trackName: "Flow Song",
      albumName: "Flow Album",
      durationMs: 1000,
    }],
  });
  const sharedJobId = downloadTracker.addJob({
    artistName: "Flow Artist",
    albumName: "Flow Album",
    albumMbid: "shared-album-mbid",
    trackName: "Flow Song",
    durationMs: 1000,
  }, sharedPlaylist.id);
  downloadTracker.setDone(sharedJobId, fixturePath);
  canonicalFavoritePlaylist = flowPlaylistConfig.createSharedPlaylist({
    name: "Canonical Favorite Playlist",
    ownerUserId: alice.id,
    tracks: [{
      artistName: "Canonical Artist",
      albumName: "Canonical Album",
      trackName: "Canonical Song",
      durationMs: 10_000,
    }],
  });
  canonicalFavoriteJobId = downloadTracker.addJob({
    artistName: "Canonical Artist",
    artistMbid: "11111111-1111-4111-8111-111111111111",
    albumName: "Canonical Album",
    albumMbid: "22222222-2222-4222-8222-222222222222",
    trackName: "Canonical Song",
    trackMbid: "55555555-5555-4555-8555-555555555555",
    durationMs: 10_000,
  }, canonicalFavoritePlaylist.id);
  downloadTracker.setDone(canonicalFavoriteJobId, fixturePath, "Canonical Album");
  const syncedFavoriteTrack = {
    artistName: "Synced Favorite Artist",
    albumName: "Synced Favorite Album",
    trackName: "Synced Favorite Song",
    durationMs: 1000,
  };
  syncedFavoritePlaylist = flowPlaylistConfig.createSharedPlaylist({
    name: "Synced Favorite Playlist",
    ownerUserId: alice.id,
    tracks: [syncedFavoriteTrack],
    importSource: {
      provider: "lastfm-station",
      externalId: "synced-favorite",
      syncEnabled: true,
      syncIntervalHours: 24,
      keepRemovedTracks: false,
    },
  });
  syncedFavoriteSourcePath = path.join(
    process.env.WEEKLY_FLOW_FOLDER,
    "aurral-weekly-flow",
    syncedFavoritePlaylist.id,
    syncedFavoriteTrack.artistName,
    syncedFavoriteTrack.albumName,
    `${syncedFavoriteTrack.trackName}.flac`,
  );
  await mkdir(path.dirname(syncedFavoriteSourcePath), { recursive: true });
  await writeFile(syncedFavoriteSourcePath, "synced favorite");
  syncedFavoriteSourceJobId = downloadTracker.addJob(syncedFavoriteTrack, syncedFavoritePlaylist.id);
  downloadTracker.setDone(syncedFavoriteSourceJobId, syncedFavoriteSourcePath, syncedFavoriteTrack.albumName);
  const favoriteFlow = flowPlaylistConfig.createFlow({ name: "Favorite Toggle Flow", size: 1 });
  const favoritePath = path.join(fixtureRoot, "Favorite Artist", "Favorite Album", "Favorite Song.flac");
  await mkdir(path.dirname(favoritePath), { recursive: true });
  await writeFile(favoritePath, "favorite");
  const favoriteJobId = downloadTracker.addJob({
    artistName: "Favorite Artist",
    albumName: "Favorite Album",
    trackName: "Favorite Song",
    durationMs: 1000,
  }, favoriteFlow.id);
  downloadTracker.setDone(favoriteJobId, favoritePath);
  await mkdir(playlistManager.libraryRoot, { recursive: true });
  await writeFile(
    path.join(playlistManager.libraryRoot, `${playlistManager.getPlaylistName(flow.id)}.webp`),
    "flow-artwork",
  );
  await writeFile(
    path.join(playlistManager.libraryRoot, `${playlistManager.getPlaylistName(sharedPlaylist.id)}.webp`),
    "shared-artwork",
  );
  aurral = await startServerProcess();
  const login = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "password123" }),
  });
  authToken = (await login.json()).token;
  assert.equal(login.status, 200);
});

test.after(async () => {
  await aurral?.stop();
  if (syncedFavoritePlaylist) {
    downloadTracker.clearByPlaylistType(syncedFavoritePlaylist.id);
    flowPlaylistConfig.deleteSharedPlaylist(syncedFavoritePlaylist.id);
  }
  await rm(syncedFavoriteSourcePath, { force: true }).catch(() => {});
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
  assert.equal(artist.genre, "Rock");
  assert.equal(artistsResult.artists.ignoredArticles, "The El La Los Las Le Les");
  const artistsXml = await request("getArtists", { f: "xml" });
  assert.match(artistsXml.body, /<artists[^>]*><index name="C"><artist id="artist:/);

  const license = responseJson(await request("getLicense"));
  assert.equal(license.license.valid, true);
  const indexes = responseJson(await request("getIndexes"));
  assert.equal(typeof indexes.indexes.lastModified, "number");
  const albumList = responseJson(await request("getAlbumList2", { type: "newest", size: 10 }));
  assert.equal(albumList.albumList2.album[0].title, "Canonical Album");
  assert.deepEqual(responseJson(await request("getGenres")).genres.genre, [
    { albumCount: 1, songCount: 1, value: "Rock" },
  ]);
  const songsByGenre = responseJson(await request("getSongsByGenre", {
    genre: "Rock",
    count: 10,
    offset: 0,
  }));
  assert.equal(songsByGenre.songsByGenre.song[0].title, "Canonical Song");
  assert.deepEqual(responseJson(await request("getStarred")).starred, {
    album: [],
    artist: [],
    song: [],
  });

  const albumResult = responseJson(await request("getArtist", { id: artist.id }));
  const album = albumResult.artist.album[0];
  assert.match(album.id, /^album:/);
  assert.equal(album.genre, "Rock");
  assert.deepEqual(responseJson(await request("getArtistInfo", { id: artist.id })).artistInfo.similarArtist, []);
  assert.deepEqual(responseJson(await request("getArtistInfo2", { id: artist.id })).artistInfo2.similarArtist, []);
  assert.equal(responseJson(await request("getArtistInfo2", { id: "artist:missing" })).error.code, 70);
  assert.deepEqual(responseJson(await request("getAlbumInfo2", { id: album.id })).albumInfo, {});
  assert.equal(responseJson(await request("getAlbumInfo2", { id: "album:missing" })).error.code, 70);
  assert.deepEqual(responseJson(await request("getSimilarSongs2", { id: "song:missing" })).similarSongs2, { song: [] });
  assert.deepEqual(responseJson(await request("getLyrics", { artist: "Canonical Artist", title: "Canonical Song" })).lyrics, { value: "" });
  assert.match((await request("getLyrics", { artist: "Canonical Artist", title: "Canonical Song", f: "xml" })).body, /<lyrics\/>/);
  assert.deepEqual(responseJson(await request("getInternetRadioStations")).internetRadioStations, { internetRadioStation: [] });
  assert.deepEqual(responseJson(await request("getPodcasts")).podcasts, { channel: [] });
  assert.equal(responseJson(await request("getTopSongs", { artist: "Canonical Artist" })).topSongs.song[0].title, "Canonical Song");
  assert.equal(responseJson(await request("getTopSongs", { id: artist.id })).topSongs.song[0].title, "Canonical Song");
  assert.equal(responseJson(await request("getTopSongs", { id: "artist:missing" })).error.code, 70);

  const songResult = responseJson(await request("getAlbum", { id: album.id }));
  const song = songResult.album.song[0];
  assert.match(song.id, /^song:/);
  assert.equal(responseJson(await request("getSong", { id: song.id })).song.title, "Canonical Song");
  assert.equal(song.contentType, "audio/flac");
  assert.equal(song.genre, "Rock");
  assert.equal(song.musicBrainzId, "33333333-3333-4333-8333-333333333333");
  assert.equal(song.mediaType, "song");
  assert.equal(album.mediaType, "album");
  assert.equal(artist.musicBrainzId, "11111111-1111-4111-8111-111111111111");
  assert.equal(artist.mediaType, "artist");
  assert.equal(album.musicBrainzId, "22222222-2222-4222-8222-222222222222");
  assert.match((await request("getSong", { id: song.id, f: "xml" })).body, /musicBrainzId="33333333-/);
  assert.equal(song.path, song.id);
  assert.deepEqual(song.artists, [
    { id: artist.id, name: "Canonical Artist", musicBrainzId: "11111111-1111-4111-8111-111111111111" },
  ]);

  assert.equal(
    responseJson(await request("star", { id: [song.id, album.id], artistId: artist.id })).status,
    "ok",
  );
  const starred = responseJson(await request("getStarred")).starred;
  assert.equal(starred.song[0].id, song.id);
  assert.equal(starred.album[0].id, album.id);
  assert.equal(starred.artist[0].id, artist.id);
  assert.equal(responseJson(await request("getStarred2")).starred2.song[0].id, song.id);
  assert.match(starred.song[0].starred, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(responseJson(await request("getSong", { id: song.id })).song.starred, /^\d{4}-/);
  assert.match(responseJson(await request("getAlbum", { id: album.id })).album.starred, /^\d{4}-/);
  assert.match(responseJson(await request("getArtist", { id: artist.id })).artist.starred, /^\d{4}-/);
  assert.match(
    responseJson(await request("search3", { query: "Canonical" })).searchResult3.song[0].starred,
    /^\d{4}-/,
  );
  userOps.createUser("bob", hashPassword("bob-password"), "user");
  assert.deepEqual(
    responseJson(await request("getStarred", { u: "bob", p: "bob-password" })).starred,
    { album: [], artist: [], song: [] },
  );
  assert.equal(
    responseJson(await request("getSong", { id: song.id, u: "bob", p: "bob-password" })).song.starred,
    undefined,
  );
  assert.equal(
    responseJson(await request("unstar", { id: [song.id, album.id], artistId: artist.id })).status,
    "ok",
  );
  assert.deepEqual(responseJson(await request("getStarred")).starred, { album: [], artist: [], song: [] });
  assert.equal(responseJson(await request("getSong", { id: song.id })).song.starred, undefined);
  assert.equal(
    responseJson(await request("star", { id: [song.id, "song:missing"] })).error.code,
    70,
  );
  assert.deepEqual(responseJson(await request("getStarred")).starred, { album: [], artist: [], song: [] });

  const missingArtist = await request("getTopSongs", { artist: "   " });
  assert.equal(responseJson(missingArtist).error.code, 10);
});

test("emits OpenSubsonic XML envelopes and elements", async () => {
  const userXml = await request("getUser", { f: "xml" });
  assert.match(
    userXml.body,
    /<subsonic-response xmlns="http:\/\/subsonic\.org\/restapi" status="ok" version="1\.16\.1" type="Aurral" serverVersion="[^"]+" openSubsonic="true">/,
  );
  assert.match(userXml.body, /videoConversionRole="false"/);
  assert.match(userXml.body, /<folder>1<\/folder>/);

  const foldersXml = await request("getMusicFolders", { f: "xml" });
  assert.match(foldersXml.body, /<musicFolder id="1" name="Aurral"\/>/);

  const artistsXml = await request("getArtists", { f: "xml" });
  assert.doesNotMatch(artistsXml.body, /<(?:albumArtists|genres)(?:\s|>)/);

  const artist = responseJson(await request("getArtists", { f: "json" })).artists.index[0].artist[0];
  const artistDetailXml = await request("getArtist", { f: "xml", id: artist.id });
  assert.doesNotMatch(artistDetailXml.body, /<(?:artists|albumArtists|genres)(?:\s|>)/);

  const album = responseJson(await request("getArtist", { f: "json", id: artist.id })).artist.album[0];
  const albumXml = await request("getAlbum", { f: "xml", id: album.id });
  assert.doesNotMatch(albumXml.body, /<(?:artists|albumArtists|genres)(?:\s|>)/);

  const genresXml = await request("getGenres", { f: "xml" });
  assert.match(genresXml.body, /<genre albumCount="1" songCount="1">Rock<\/genre>/);

  const directoryXml = await request("getMusicDirectory", { f: "xml", id: "1" });
  assert.match(directoryXml.body, /<directory[^>]*id="1"[^>]*name="Aurral"/);
  assert.match(directoryXml.body, /parent="1"/);
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
  assert.equal(flow.coverArt, flow.id);
  const playlist = responseJson(await request("getPlaylist", { id: flow.id }));
  assert.equal(playlist.playlist.entry[0].title, "Flow Song");
  assert.equal(playlist.playlist.public, false);
  assert.equal(playlist.playlist.coverArt, flow.coverArt);
  const artwork = await request("getCoverArt", { id: flow.coverArt });
  assert.equal(artwork.response.status, 200);
  assert.equal(artwork.body, "flow-artwork");
});

test("accepts Feishin's empty search request for the tracks view", async () => {
  const search = responseJson(await request("search3", {
    query: "",
    artistCount: 20,
    albumCount: 20,
    songCount: 20,
  }));
  assert.equal(search.searchResult3.song[0].title, "Canonical Song");
});

test("exposes owned static playlists and keeps their entries playable", async () => {
  const playlists = responseJson(await request("getPlaylists")).playlists.playlist;
  const shared = playlists.find((entry) => entry.name === "Canonical Shared");
  assert.ok(shared);
  assert.equal(shared.songCount, 1);
  assert.equal(shared.coverArt, shared.id);

  const playlist = responseJson(await request("getPlaylist", { id: shared.id })).playlist;
  assert.equal(playlist.entry[0].title, "Flow Song");
  assert.match(playlist.entry[0].id, /^shared-song:/);
  const artwork = await request("getCoverArt", { id: shared.coverArt });
  assert.equal(artwork.response.status, 200);
  assert.equal(artwork.body, "shared-artwork");

  const pendingJobId = downloadTracker.addJob({
    artistName: "Pending Artist",
    albumName: "Pending Album",
    trackName: "Pending Song",
    durationMs: 1000,
  }, sharedPlaylist.id);
  try {
    const refreshed = responseJson(await request("getPlaylist", { id: shared.id })).playlist;
    assert.equal(refreshed.entry.some((entry) => entry.title === "Pending Song"), false);
  } finally {
    downloadTracker.removeJob(pendingJobId);
  }

  const song = responseJson(await request("getSong", { id: playlist.entry[0].id })).song;
  assert.equal(song.title, "Flow Song");
  const stream = await request("stream", { id: song.id });
  assert.equal(stream.response.status, 200);
  assert.equal(stream.body, "0123456789");
});

test("returns canonical song ids for playlist entries that exist in the library", async () => {
  const playlist = responseJson(await request("getPlaylist", {
    id: `shared:${encodeURIComponent(canonicalFavoritePlaylist.id)}`,
  })).playlist;
  assert.equal(playlist.entry.length, 1);
  assert.match(playlist.entry[0].id, /^song:/);
  assert.equal(playlist.entry[0].parent, playlist.id);
  assert.equal(playlist.entry[0].title, "Canonical Song");
  assert.equal(playlist.entry[0].musicBrainzId, "33333333-3333-4333-8333-333333333333");
  const artistId = responseJson(await request("getArtists")).artists.index[0].artist[0].id;
  const album = responseJson(await request("getArtist", { id: artistId })).artist.album[0];
  const canonicalSong = responseJson(await request("getAlbum", { id: album.id })).album.song[0];
  assert.equal(playlist.entry[0].id, canonicalSong.id);
  const stream = await request("stream", { id: playlist.entry[0].id });
  assert.equal(stream.response.status, 200);
});

test("does not expose another user's static playlist", async () => {
  userOps.createUser("bob", hashPassword("bob-password"), "user");
  const result = responseJson(await request("getPlaylist", {
    id: `shared:${encodeURIComponent(sharedPlaylist.id)}`,
    u: "bob",
    p: "bob-password",
  }));
  assert.deepEqual(result.error, { code: 70, message: "Requested data was not found" });
});

test("creates durable Subsonic playlists around one promoted library job", async () => {
  const flow = responseJson(await request("getPlaylists")).playlists.playlist.find(
    (entry) => entry.name === "Canonical Flow",
  );
  const flowPlaylist = responseJson(await request("getPlaylist", { id: flow.id })).playlist;
  const flowSong = flowPlaylist.entry[0];

  const firstCreate = responseJson(await request("createPlaylist", {
    name: "Subsonic Keep One",
    songId: flowSong.id,
  }));
  const firstId = firstCreate.playlist.id;
  const first = await waitFor(async () => {
    const playlist = responseJson(await request("getPlaylist", { id: firstId })).playlist;
    return playlist.entry?.[0] ? playlist : null;
  });
  assert.equal(first.name, "Subsonic Keep One");
  const jobIdFromSong = (songId) =>
    decodeURIComponent(songId.slice("shared-song:".length)).split(":").at(-1);
  const canonicalJobId = jobIdFromSong(first.entry[0].id);

  const secondCreate = responseJson(await request("createPlaylist", {
    name: "Subsonic Keep Two",
    songId: flowSong.id,
  }));
  const second = await waitFor(async () => {
    const playlist = responseJson(await request("getPlaylist", { id: secondCreate.playlist.id })).playlist;
    return playlist.entry?.[0] ? playlist : null;
  });
  const secondAurralPlaylistId = decodeURIComponent(
    secondCreate.playlist.id.slice("shared:".length),
  );
  assert.equal(jobIdFromSong(second.entry[0].id), canonicalJobId);

  await waitFor(() => db.prepare(
    "SELECT status FROM playlist_download_jobs WHERE id = ?",
  ).get(canonicalJobId)?.status === "done");
  const firstReady = await waitFor(async () => {
    const result = responseJson(await request("getPlaylist", { id: first.id }));
    return result.playlist?.entry?.[0];
  });
  assert.equal(firstReady.id, responseJson(await request("getPlaylist", { id: first.id })).playlist.entry[0].id);
  const stream = await request("stream", { id: firstReady.id });
  assert.equal(stream.response.status, 200);
  assert.equal(stream.body, "0123456789");

  const libraryJobs = db.prepare(
    "SELECT id, final_path AS finalPath FROM playlist_download_jobs WHERE playlist_type = ? AND track_name = ?",
  ).all("library", "Flow Song");
  assert.equal(libraryJobs.length, 1);

  const aurralPlaylistId = decodeURIComponent(firstId.slice("shared:".length));
  const aurralJobsResponse = await apiFetch(
    `/api/playlists/jobs/${encodeURIComponent(aurralPlaylistId)}`,
  );
  assert.equal(aurralJobsResponse.status, 200);
  const aurralJobs = await aurralJobsResponse.json();
  assert.equal(aurralJobs.length, 1);
  assert.equal(aurralJobs[0].id, canonicalJobId);
  assert.equal(aurralJobs[0].playlistType, aurralPlaylistId);
  assert.equal(
    (await apiFetch(`/api/playlists/stream/${encodeURIComponent(canonicalJobId)}`)).status,
    200,
  );

  const removed = responseJson(await request("updatePlaylist", {
    playlistId: first.id,
    songIndexToRemove: "0",
  }));
  assert.equal(removed.status, "ok");
  const secondEntry = responseJson(await request("getPlaylist", { id: second.id })).playlist.entry[0];
  assert.equal((await request("stream", { id: secondEntry.id })).response.status, 200);
  const removeCanonicalResponse = await apiFetch(
    `/api/playlists/shared-playlists/${encodeURIComponent(secondAurralPlaylistId)}/tracks/${encodeURIComponent(canonicalJobId)}`,
    { method: "DELETE" },
  );
  assert.equal(removeCanonicalResponse.status, 200);
  await waitFor(async () => {
    const response = await apiFetch(
      `/api/playlists/jobs/${encodeURIComponent(secondAurralPlaylistId)}`,
    );
    const jobs = await response.json();
    return jobs.length === 0 ? true : null;
  });
  await stat(libraryJobs[0].finalPath);

  assert.equal(responseJson(await request("deletePlaylist", { id: second.id })).status, "ok");
  await stat(libraryJobs[0].finalPath);
});

test("failed Subsonic playlist creation rolls back its playlist and jobs", async () => {
  const canonicalSong = responseJson(await request("search3", { query: "Canonical Song" })).searchResult3.song[0];
  const user = userOps.getUserByUsername("alice");
  const originalUpdate = flowPlaylistConfig.updateSharedPlaylist;
  flowPlaylistConfig.updateSharedPlaylist = () => null;
  try {
    assert.equal(
      createSubsonicPlaylist(user, { name: "Failed Subsonic Playlist", songIds: [canonicalSong.id] }),
      null,
    );
    assert.equal(
      flowPlaylistConfig.getSharedPlaylistsForUser(user).some(
        (playlist) => playlist.name === "Failed Subsonic Playlist",
      ),
      false,
    );
    assert.equal(
      db.prepare(
        "SELECT id FROM playlist_download_jobs WHERE playlist_type = ? AND track_name = ? LIMIT 1",
      ).get("library", "Canonical Song"),
      undefined,
    );
  } finally {
    flowPlaylistConfig.updateSharedPlaylist = originalUpdate;
  }
});

test("malformed Subsonic settings do not crash the settings update", async () => {
  const initialFavoriteAutoKeep = dbOps.getSettings().subsonic.favoriteAutoKeep;
  try {
    const disable = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({ subsonic: { favoriteAutoKeep: false } }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await (await apiFetch("/api/settings")).json()).subsonic.favoriteAutoKeep, false);
    const response = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({ subsonic: null }),
    });
    assert.equal(response.status, 200);
    assert.equal((await (await apiFetch("/api/settings")).json()).subsonic.favoriteAutoKeep, false);
    const partial = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({ subsonic: {} }),
    });
    assert.equal(partial.status, 200);
    assert.equal((await (await apiFetch("/api/settings")).json()).subsonic.favoriteAutoKeep, false);
  } finally {
    await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({ subsonic: { favoriteAutoKeep: initialFavoriteAutoKeep } }),
    });
  }
});

test("favorites can keep Flow tracks and respect the auto-keep setting", async () => {
  const flow = responseJson(await request("getPlaylists")).playlists.playlist.find(
    (entry) => entry.name === "Favorite Toggle Flow",
  );
  const entry = responseJson(await request("getPlaylist", { id: flow.id })).playlist.entry[0];

  const saveSettings = (subsonic) => apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({ subsonic }),
  });
  assert.equal((await saveSettings({ favoriteAutoKeep: false })).status, 200);
  assert.equal(responseJson(await request("star", { id: entry.id })).status, "ok");
  assert.equal(
    Boolean(db.prepare(
      "SELECT 1 FROM playlist_download_jobs WHERE playlist_type = ? AND track_name = ? LIMIT 1",
    ).get("library", "Favorite Song")),
    false,
  );
  assert.equal(responseJson(await request("getStarred")).starred.song[0].id, entry.id);
  assert.equal((await saveSettings({ favoriteAutoKeep: true })).status, 200);
  assert.equal(responseJson(await request("unstar", { id: entry.id })).status, "ok");
  assert.equal(responseJson(await request("star", { id: entry.id })).status, "ok");
  const autoKeepJob = db.prepare(
    "SELECT id FROM playlist_download_jobs WHERE playlist_type = ? AND track_name = ? LIMIT 1",
  ).get("library", "Favorite Song");
  assert.ok(autoKeepJob);
  downloadTracker.removeJob(autoKeepJob.id);
  assert.equal(responseJson(await request("unstar", { id: entry.id })).status, "ok");
});

test("favoriting a synced playlist track keeps it when the source removes it", async () => {
  const playlist = syncedFavoritePlaylist;
  const track = playlist.tracks[0];
  const sourcePath = syncedFavoriteSourcePath;
  const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;
  const originalStart = weeklyFlowWorker.start;
  let libraryJobId;
  try {
    weeklyFlowWorker.start = async () => false;
    const songId = `shared-song:${encodeURIComponent(`${playlist.id}:${syncedFavoriteSourceJobId}`)}`;
    assert.equal(star(userOps.getUserByUsername("alice"), songId), true);

    const libraryJob = db.prepare(
      "SELECT id, status, final_path AS finalPath FROM playlist_download_jobs WHERE playlist_type = ? AND track_name = ? LIMIT 1",
    ).get("library", track.trackName);
    assert.ok(libraryJob);
    assert.equal(libraryJob.status, "done");
    libraryJobId = libraryJob.id;

    await updateSharedPlaylist({
      playlistId: playlist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: {
        ...playlist.importSource,
        lastSyncAt: Date.now(),
        lastSyncTrackCount: 0,
      },
      mergeImportSource: true,
    });

    const updatedLibraryJob = db.prepare(
      "SELECT final_path AS finalPath FROM playlist_download_jobs WHERE id = ?",
    ).get(libraryJobId);
    await stat(updatedLibraryJob.finalPath);
    await assert.rejects(stat(sourcePath));
  } finally {
    weeklyFlowWorker.start = originalStart;
    downloadTracker.clearByPlaylistType(playlist.id);
    if (libraryJobId) downloadTracker.removeJob(libraryJobId);
    await rm(path.join(weeklyFlowRoot, track.artistName), { recursive: true, force: true });
    flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
  }
});

test("playlist favorites resolve to the owned canonical track", async () => {
  const playlistSongId = `shared-song:${encodeURIComponent(`${canonicalFavoritePlaylist.id}:${canonicalFavoriteJobId}`)}`;
  let canonicalSongId;
  try {
    assert.equal(responseJson(await request("star", { id: playlistSongId })).status, "ok");

    const favorites = await (await apiFetch("/api/library/favorites")).json();
    assert.deepEqual(favorites.library.tracks.map((track) => track.title), ["Canonical Song"]);
    assert.equal(favorites.song.some((song) => /^song:/.test(song.id)), true);

    const album = responseJson(await request("getArtist", {
      id: responseJson(await request("getArtists")).artists.index[0].artist[0].id,
    })).artist.album[0];
    canonicalSongId = responseJson(await request("getAlbum", { id: album.id })).album.song[0].id;
    const page = await (await apiFetch(
      "/api/library/canonical?kind=tracks&page=1&pageSize=100&availableOnly=true",
    )).json();
    assert.equal(page.items.find((track) => track.title === "Canonical Song").userFavorite, true);

    assert.equal(responseJson(await request("unstar", { id: canonicalSongId })).status, "ok");
    assert.equal(
      responseJson(await request("getStarred")).starred.song.some(
        (song) => song.id === canonicalSongId,
      ),
      false,
    );
  } finally {
    await request("unstar", { id: [playlistSongId, canonicalSongId].filter(Boolean) });
  }
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
    `http://127.0.0.1:${aurral.port}/api/library/canonical?source=lidarr&availableOnly=true&kind=tracks&page=1&pageSize=100`,
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
  const source = "https://example.com/cover.jpg";
  dbOps.setImage("11111111-1111-4111-8111-111111111111", source);
  const result = await request("getCoverArt", { id: artist.id }, { redirect: "manual" });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), source);
  assert.equal(result.response.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("resolves playlist release-group artwork without a canonical album row", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      { headers: { "content-type": "image/png" } },
    );
  try {
    const cached = await warmImageProxy("https://images.example/playlist.webp");
    const releaseGroupId = "44444444-4444-4444-8444-444444444444";
    dbOps.setImage(`rg:${releaseGroupId}`, cached.localUrl);

    const artwork = await resolveArtworkUrl(
      `album:${encodeURIComponent(`release-group:${releaseGroupId}`)}`,
    );
    const libraryArtwork = await warmImageProxy(cached.localUrl, "library");
    assert.equal(artwork, libraryArtwork.localUrl);
  } finally {
    global.fetch = originalFetch;
  }
});

test("uses cached album artwork for artist artwork", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      { headers: { "content-type": "image/png" } },
    );
  try {
    const artist = db.prepare("SELECT mbid, identity_key FROM library_artists LIMIT 1").get();
    const album = db.prepare("SELECT mbid, release_group_mbid FROM library_albums LIMIT 1").get();
    const cacheId = album.release_group_mbid || album.mbid;
    const cached = await warmImageProxy(`https://images.example/artist-album-${cacheId}.png`);
    dbOps.deleteImage(artist.mbid);
    dbOps.setImage(`rg:${cacheId}`, cached.localUrl);

    const artwork = await resolveArtworkUrl(`artist:${encodeURIComponent(artist.identity_key)}`);
    const libraryArtwork = await warmImageProxy(cached.localUrl, "library");
    assert.equal(artwork, libraryArtwork.localUrl);
  } finally {
    global.fetch = originalFetch;
  }
});
