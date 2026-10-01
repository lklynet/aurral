import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrainzmash } from "../tests/lab/services/brainzmash.mjs";
import { createDeemix } from "../tests/lab/services/deemix.mjs";
import { createLidarr } from "../tests/lab/services/lidarr.mjs";
import { createDownloads, createTrackFiles } from "../tests/lab/services/runtime.mjs";
import { createSlskd } from "../tests/lab/services/slskd.mjs";
import { createUsenet } from "../tests/lab/services/usenet.mjs";
import { cleanupIsolatedState, createMockHttpServer, setupIsolatedBackend } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(repoRoot, "tests", "lab", "fixtures", "catalog.json"), "utf8"));
const [paths, { dbOps }, provider, { lidarrClient }, { slskdClient }, { prowlarrClient }, { sabnzbdClient }, { nzbgetClient }, { deemixClient }, ytdlp] =
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
    const body = !text ? undefined : type.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
    const result = (await handler({ method: request.method, url: new URL(request.url, "http://fixtures"), headers: request.headers, body })) ||
      { status: 501, body: { error: "unsupported" } };
    if (result.status === 204) {
      response.writeHead(204, result.headers);
      return response.end();
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
