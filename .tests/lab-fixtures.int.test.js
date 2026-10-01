import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrainzmash } from "../tests/lab/services/brainzmash.mjs";
import { createDeemix } from "../tests/lab/services/deemix.mjs";
import { createLidarr } from "../tests/lab/services/lidarr.mjs";
import { createDownloads, createTrackFiles, writeTrack } from "../tests/lab/services/runtime.mjs";
import { createJellyfin } from "../tests/lab/services/jellyfin.mjs";
import { createKoito } from "../tests/lab/services/koito.mjs";
import { createMediaIndex } from "../tests/lab/services/media.mjs";
import { createNavidrome } from "../tests/lab/services/navidrome.mjs";
import { createPlex } from "../tests/lab/services/plex.mjs";
import { createSlskd } from "../tests/lab/services/slskd.mjs";
import { createUsenet } from "../tests/lab/services/usenet.mjs";
import { cleanupIsolatedState, createMockHttpServer, setupIsolatedBackend } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(repoRoot, "tests", "lab", "fixtures", "catalog.json"), "utf8"));
const [paths, { dbOps }, provider, { lidarrClient }, { slskdClient }, { prowlarrClient }, { sabnzbdClient }, { nzbgetClient }, { deemixClient }, ytdlp, { NavidromeClient }, { PlexClient }, { JellyfinClient }, { fetchKoitoTopArtists }] =
  await setupIsolatedBackend(
    "lab-fixtures",
    "backend/db/helpers/index.js",
    "backend/services/providers/brainzmashProvider.js",
    "backend/services/lidarrClient.js",
    "backend/services/slskdClient.js",
    "backend/services/prowlarrClient.js",
    "backend/services/sabnzbdClient.js",
    "backend/services/nzbgetClient.js",
    "backend/services/deemixClient.js",
    "backend/services/ytdlpClient.js",
    "backend/services/navidrome.js",
    "backend/services/plex.js",
    "backend/services/jellyfin.js",
    "backend/services/koitoClient.js",
  );
test.after(() => cleanupIsolatedState(paths));

const [artist] = catalog.artists.filter((entry) => entry.albums.some((album) => album.tracks.length > 1));
const album = artist.albums.find((entry) => entry.tracks.length > 1);

function labContext(t) {
  const mediaRoot = join(paths.baseDir, `media-${t.name.length}-${Date.now()}`);
  return {
    mediaRoot,
    downloads: createDownloads("complete", { queuedMs: 20, downloadingMs: 20 }),
    tracks: createTrackFiles(join(tmpdir(), `aurral-lab-test-tracks-${process.pid}`)),
  };
}

async function serve(t, handler) {
  const server = await createMockHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const type = String(request.headers["content-type"] || "");
    let body;
    if (text && type.includes("x-www-form-urlencoded")) {
      body = {};
      for (const [key, value] of new URLSearchParams(text)) body[key] = key in body ? [].concat(body[key], value) : value;
    } else if (text) {
      body = JSON.parse(text);
    }
    const result = (await handler({ method: request.method, url: new URL(request.url, "http://fixtures"), headers: request.headers, body })) ||
      { status: 501, body: { error: "unsupported" } };
    if (result.status === 204) {
      response.writeHead(204, result.headers);
      return response.end();
    }
    if (result.raw !== undefined) {
      response.writeHead(result.status, result.headers);
      return response.end(result.raw);
    }
    response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    response.end(JSON.stringify(result.body ?? null));
  });
  t.after(() => server.close());
  return server.url;
}

function configure(integrations) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({ ...settings, integrations: { ...settings.integrations, ...integrations } });
  provider.clearMetadataProviderCaches();
}

async function eventually(read, accept = Boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const audioFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => /\.(flac|m4a)$/.test(name)) : []);

test("Aurral's metadata provider reads every Lab catalog artist, album, and search", async (t) => {
  const baseUrl = await serve(t, createBrainzmash(catalog));
  configure({ metadata: { provider: "brainzmash", baseUrl, enableNarrowFallbacks: false } });

  for (const entry of catalog.artists) {
    assert.equal((await provider.getArtistByMbid(entry.id)).name, entry.name);
    const albums = await provider.listArtistAlbums(entry.id, { hydrateLimit: 0 });
    assert.deepEqual(albums.map((item) => item.title).sort(), entry.albums.map((item) => item.title).sort());
    assert.ok(albums.every((item) => item.firstReleaseDate));
    for (const item of entry.albums) {
      const tracks = await provider.getAlbumTracksByAlbumMbid(item.id);
      assert.deepEqual(tracks.map((track) => track.title), item.tracks);
      assert.ok(tracks.every((track) => track.recordingId && track.durationMs > 0));
    }
    const search = await provider.searchArtists(entry.name.split(" ")[0]);
    assert.ok(search.items.some((item) => item.id === entry.id), `search did not find ${entry.name}`);
  }

  await assert.rejects(
    provider.getArtistByMbid("00000000-0000-4000-8000-000000000000"),
    (error) => error?.response?.status === 404,
  );
});

test("Lidarr adds an artist, downloads its monitored albums, imports files, and removes them", async (t) => {
  const context = labContext(t);
  const apiKey = "lab-fixture-key";
  const lidarr = createLidarr(catalog, { ...context, apiKey });
  const url = await serve(t, lidarr);
  const rootFolder = join(context.mediaRoot, "lidarr");
  configure({ lidarr: { url, apiKey, rootFolderPath: rootFolder, rootFolderPaths: [rootFolder], qualityProfileId: 1, metadataProfileId: 1 } });

  const added = await lidarrClient.addArtist(artist.id, artist.name, { monitorOption: "none" });
  assert.equal((await lidarrClient.getArtistByMbid(artist.id, { forceRefresh: true }))?.id, added.id);
  const albums = await lidarrClient.request(`/album?artistId=${added.id}`);
  assert.equal(albums.length, artist.albums.length);
  const target = albums.find((entry) => entry.foreignAlbumId === album.id);

  await lidarrClient.monitorAlbum(target.id, true);
  await lidarrClient.triggerAlbumSearch(target.id);
  assert.equal((await lidarrClient.getQueue({ forceRefresh: true })).length, 1);
  await eventually(async () => (await lidarrClient.getQueue({ forceRefresh: true })).length === 0);
  const files = await lidarrClient.request(`/trackfile?albumId=${target.id}`);
  assert.equal(files.length, album.tracks.length);
  assert.ok(files.every((file) => statSync(file.path).size === file.size && file.path.startsWith(rootFolder)));
  const events = (await lidarrClient.getHistoryForAlbum(target.id)).map((entry) => entry.eventType);
  assert.ok(events.includes("grabbed") && events.includes("trackFileImported"));

  await lidarrClient.deleteArtist(added.id, true);
  assert.deepEqual(lidarr.state.artists, []);
  assert.ok(files.every((file) => !existsSync(file.path)));

  configure({ lidarr: { url, apiKey: "wrong-key", rootFolderPath: rootFolder, qualityProfileId: 1, metadataProfileId: 1 } });
  assert.notEqual((await lidarrClient.testConnection()).connected, true);
});

test("slskd searches, downloads into its downloads folder, and cancels through the Lab fixture", async (t) => {
  const context = labContext(t);
  const apiKey = "lab-slskd-key";
  const url = await serve(t, createSlskd(catalog, { ...context, apiKey }));
  configure({ slskd: { enabled: true, url, apiKey } });

  const connection = await slskdClient.testConnection({ force: true });
  assert.equal(connection.connected, true);
  const search = await slskdClient.createSearch(`${artist.name} ${album.title}`);
  const result = await slskdClient.getSearch(search.id);
  const [response] = result.responses;
  assert.equal(response.files.length, album.tracks.length);
  assert.deepEqual((await slskdClient.getSearch((await slskdClient.createSearch(`${artist.name} not in the catalog`)).id)).responses, []);

  const [first, second] = response.files;
  const completed = await slskdClient.enqueueBatch({ username: response.username, files: [first] });
  const finished = await eventually(() => slskdClient.getTransfer(response.username, completed.transferId), (transfer) => /Succeeded/.test(transfer.state));
  assert.equal(finished.bytesTransferred, first.size);
  const parts = first.filename.split("\\");
  assert.equal(statSync(join(connection.downloadPath, parts.at(-2), parts.at(-1))).size, first.size);

  context.downloads.setMode("hold");
  const held = await slskdClient.enqueueBatch({ username: response.username, files: [second] });
  assert.match((await slskdClient.getTransfer(response.username, held.transferId)).state, /Queued/);
  assert.equal(await slskdClient.deleteTransfer(response.username, held.transferId), true);
  assert.equal(await slskdClient.getTransfer(response.username, held.transferId), null);

  configure({ slskd: { enabled: true, url, apiKey: "wrong-key" } });
  assert.notEqual((await slskdClient.testConnection({ force: true })).connected, true);
});

test("Prowlarr releases download through SABnzbd and NZBGet into their completed folders", async (t) => {
  const context = labContext(t);
  const credentials = { prowlarrApiKey: "lab-prowlarr", sabnzbdApiKey: "lab-sab", nzbgetUsername: "lab", nzbgetPassword: "lab-pass" };
  const usenet = createUsenet(catalog, { ...context, ...credentials });
  configure({
    prowlarr: { enabled: true, url: await serve(t, usenet.prowlarr), apiKey: credentials.prowlarrApiKey },
    sabnzbd: { enabled: true, url: await serve(t, usenet.sabnzbd), apiKey: credentials.sabnzbdApiKey },
    nzbget: { enabled: true, url: await serve(t, usenet.nzbget), username: credentials.nzbgetUsername, password: credentials.nzbgetPassword },
  });

  assert.equal((await prowlarrClient.testConnection({ force: true })).usenetIndexerCount, 1);
  const [release] = await prowlarrClient.search(`${artist.name} ${album.title}`);
  assert.match(release.title, new RegExp(album.title));

  for (const client of [sabnzbdClient, nzbgetClient]) {
    const connection = await client.testConnection({ force: true });
    assert.equal(connection.connected, true, `${client.name}: ${connection.message}`);
    const appended = await client.appendUrl({ name: release.title, url: release.downloadUrl });
    assert.ok(await client.getQueueItem(appended.nzbId), `${client.name} did not queue the release`);
    const history = await eventually(() => client.getHistoryItem(appended.nzbId));
    const folder = history.storage || history.DestDir;
    assert.equal(audioFiles(folder).length, album.tracks.length, `${client.name} completed folder`);
    assert.equal(await client.getQueueItem(appended.nzbId), null);
  }

  configure({ sabnzbd: { enabled: true, url: (await serve(t, usenet.sabnzbd)), apiKey: "wrong-key" } });
  assert.equal(await sabnzbdClient.appendUrl({ name: release.title, url: release.downloadUrl }).catch(() => "rejected"), "rejected");
});

test("deemix queues a Deezer track and reports the downloaded file", async (t) => {
  const context = labContext(t);
  configure({ deemix: { enabled: true, url: await serve(t, createDeemix(catalog, context)) } });

  assert.equal((await deemixClient.testConnection({ force: true })).ok, true);
  const [track] = await deemixClient.search(`${artist.name} ${album.tracks[0]}`);
  assert.equal(track.title, album.tracks[0]);
  const uuid = await deemixClient.addToQueue(track.url, track.id);
  const item = await eventually(() => deemixClient.getQueueItem(uuid), (entry) => entry?.status === "completed");
  assert.ok(statSync(item.files[0].path).size > 0);
  assert.equal(await deemixClient.removeFromQueue(uuid), true);
  assert.equal(await deemixClient.getQueueItem(uuid), null);
});

test("the Lab yt-dlp searches and writes tagged audio where Aurral asks", async (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = `${join(repoRoot, "tests", "lab", "bin")}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  assert.match((await ytdlp.testConnection({ force: true })).message || "", /lab/);
  const [video] = await ytdlp.search(`${artist.name} ${album.tracks[0]}`);
  assert.equal(video.title, `${artist.name} - ${album.tracks[0]}`);
  const { filePath } = await ytdlp.downloadAudio(video.url, { jobId: "lab-test" });
  assert.ok(statSync(filePath).size > 0);
  await ytdlp.cleanupStaging("lab-test");
});

function playbackLibrary(t) {
  const context = labContext(t);
  const playlistRoot = join(context.mediaRoot, "downloads", "aurral", "aurral-weekly-flow");
  const files = album.tracks.map((title, index) => {
    const file = join(context.mediaRoot, "downloads", "aurral", artist.name, album.title, `${index + 1} - ${title}.flac`);
    writeTrack(file, { artist: artist.name, album: album.title, title, trackNumber: index + 1, durationSeconds: 2 });
    return file;
  });
  mkdirSync(join(playlistRoot, "_flows"), { recursive: true });
  return { ...context, media: createMediaIndex(context.mediaRoot), files, playlistRoot };
}

test("Navidrome indexes Lab media, prepares Aurral's library, and edits playlists through Subsonic", async (t) => {
  const library = playbackLibrary(t);
  const navidrome = createNavidrome({ ...library, username: "lab", password: "lab-pass" });
  const client = new NavidromeClient(await serve(t, navidrome), "lab", "lab-pass");

  await client.ping();
  await client.scanLibrary();
  const created = await client.ensureWeeklyFlowLibrary(library.playlistRoot);
  assert.equal(created.path, library.playlistRoot);
  const songs = await Promise.all(library.files.map((file) => client.findSong(null, null, { path: file })));
  assert.ok(songs.every((song) => song?.id));

  const playlist = await client.createPlaylist("Lab playlist", songs.map((song) => song.id));
  assert.deepEqual((await client.getPlaylist(playlist.id)).entry.map((entry) => entry.path), library.files);
  await client.updatePlaylist(playlist.id, { name: "Renamed playlist", songIds: [songs[1].id] });
  const updated = await client.getPlaylist(playlist.id);
  assert.equal(updated.name, "Renamed playlist");
  assert.deepEqual(updated.entry.map((entry) => entry.id), [songs[1].id]);
  await client.deletePlaylist(playlist.id);
  await assert.rejects(client.getPlaylist(playlist.id), (error) => Number(error.code) === 70);

  writeFileSync(join(library.playlistRoot, "Imported.m3u"), `#EXTM3U\n${library.files[0]}\n`);
  await client.scanLibrary();
  const imported = (await client.getPlaylists()).find((entry) => entry.name === "Imported");
  assert.match(imported.comment, /Auto-imported from/);

  await assert.rejects(new NavidromeClient(await serve(t, navidrome), "lab", "wrong").ping());
});

test("Plex creates Aurral's section, finds tracks by file, and syncs a playlist", async (t) => {
  const library = playbackLibrary(t);
  const plex = createPlex({ ...library, tokens: ["lab-plex"], machineIdentifier: "lab-machine" });
  const client = new PlexClient(await serve(t, plex), "lab-plex", "lab-client");

  assert.equal((await client.ping()).machineIdentifier, "lab-machine");
  const section = await client.ensureWeeklyFlowLibrary(library.playlistRoot);
  assert.equal(section.title, "Aurral");
  const tracks = await client.getTracks("1");
  assert.deepEqual(tracks.flatMap((track) => track.files).sort(), [...library.files].sort());

  const synced = await client.syncPlaylist({ title: "Lab playlist", ratingKeys: tracks.map((track) => track.ratingKey) });
  assert.equal((await client.getPlaylistItems(synced.ratingKey)).length, tracks.length);
  await client.deletePlaylist(synced.ratingKey);
  assert.deepEqual(await client.getPlaylists(), []);

  await assert.rejects(new PlexClient(await serve(t, plex), "wrong", "lab-client").ping());
});

test("Jellyfin lists Lab audio and keeps Aurral's playlist entries in sync", async (t) => {
  const library = playbackLibrary(t);
  const jellyfin = createJellyfin({ ...library, apiKey: "lab-jellyfin", username: "lab" });
  const client = new JellyfinClient(await serve(t, jellyfin), "lab-jellyfin", jellyfin.userId);

  await client.ping();
  await client.scanLibrary();
  const audio = await client.getAudioItems();
  assert.deepEqual(audio.map((item) => item.Path).sort(), [...library.files].sort());

  const { Id } = await client.createPlaylist({ name: "Lab playlist", itemIds: [audio[0].Id] });
  const result = await client.updatePlaylist(Id, { name: "Renamed playlist", itemIds: audio.map((item) => item.Id), managedItemIds: [audio[0].Id] });
  assert.equal(result.managedItemIds.length, audio.length);
  assert.equal((await client.getPlaylistMetadata(Id)).Name, "Renamed playlist");
  assert.deepEqual((await client.getPlaylistItems(Id)).map((item) => item.Id).sort(), audio.map((item) => item.Id).sort());
  await client.deletePlaylist(Id);
  assert.deepEqual(jellyfin.state.playlists, []);

  await assert.rejects(new JellyfinClient(await serve(t, jellyfin), "wrong", jellyfin.userId).ping());
});

test("Koito reports top artists with MusicBrainz IDs", async (t) => {
  const url = await serve(t, createKoito(catalog, { token: "lab-koito" }));
  const artists = await fetchKoitoTopArtists(url, { discoveryPeriod: "1month", limit: 3 });
  assert.equal(artists.length, 3);
  assert.ok(artists.every((entry) => catalog.artists.some((candidate) => candidate.id === entry.mbid)));
});
