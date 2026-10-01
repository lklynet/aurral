import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrainzmash } from "../tests/lab/services/brainzmash.mjs";
import { createLidarr } from "../tests/lab/services/lidarr.mjs";
import { createSlskd } from "../tests/lab/services/slskd.mjs";
import { cleanupIsolatedState, createMockHttpServer, setupIsolatedBackend } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(repoRoot, "tests", "lab", "fixtures", "catalog.json"), "utf8"));
const [paths, { dbOps }, provider, { lidarrClient }, { slskdClient }] = await setupIsolatedBackend(
  "lab-fixtures",
  "backend/db/helpers/index.js",
  "backend/services/providers/brainzmashProvider.js",
  "backend/services/lidarrClient.js",
  "backend/services/slskdClient.js",
);
test.after(() => cleanupIsolatedState(paths));

async function serve(t, handler) {
  const server = await createMockHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const result = (await handler({
      method: request.method,
      url: new URL(request.url, "http://fixtures"),
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    })) || { status: 501, body: { error: "unsupported" } };
    response.writeHead(result.status, { "content-type": "application/json" });
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

test("Aurral's metadata provider reads every Lab catalog artist, album, and search", async (t) => {
  const baseUrl = await serve(t, createBrainzmash(catalog));
  configure({ metadata: { provider: "brainzmash", baseUrl, enableNarrowFallbacks: false } });

  for (const artist of catalog.artists) {
    assert.equal((await provider.getArtistByMbid(artist.id)).name, artist.name);
    const albums = await provider.listArtistAlbums(artist.id, { hydrateLimit: 0 });
    assert.deepEqual(albums.map((album) => album.title).sort(), artist.albums.map((album) => album.title).sort());
    assert.ok(albums.every((album) => album.firstReleaseDate));
    for (const album of artist.albums) {
      const tracks = await provider.getAlbumTracksByAlbumMbid(album.id);
      assert.deepEqual(tracks.map((track) => track.title), album.tracks);
      assert.ok(tracks.every((track) => track.recordingId && track.durationMs > 0));
    }
    const search = await provider.searchArtists(artist.name.split(" ")[0]);
    assert.ok(search.items.some((item) => item.id === artist.id), `search did not find ${artist.name}`);
  }

  await assert.rejects(
    provider.getArtistByMbid("00000000-0000-4000-8000-000000000000"),
    (error) => error?.response?.status === 404,
  );
});

test("Aurral adds and removes a Lidarr artist through the Lab fixture", async (t) => {
  const apiKey = "lab-fixture-key";
  const lidarr = createLidarr(catalog, { apiKey });
  const url = await serve(t, lidarr);
  const [artist] = catalog.artists;
  configure({
    lidarr: { url, apiKey, rootFolderPath: "/music", rootFolderPaths: ["/music"], qualityProfileId: 1, metadataProfileId: 1 },
  });

  const added = await lidarrClient.addArtist(artist.id, artist.name, { monitorOption: "none" });
  assert.ok(Number.isInteger(added.id));
  assert.deepEqual(lidarr.state.artists.map((entry) => entry.foreignArtistId), [artist.id]);
  assert.equal(lidarr.state.albums.filter((album) => album.artistId === added.id).length, artist.albums.length);
  assert.equal((await lidarrClient.getArtistByMbid(artist.id, { forceRefresh: true }))?.id, added.id);

  await lidarrClient.deleteArtist(added.id, false);
  assert.deepEqual(lidarr.state.artists, []);
  assert.deepEqual(lidarr.state.albums, []);

  configure({ lidarr: { url, apiKey: "wrong-key", rootFolderPath: "/music", qualityProfileId: 1, metadataProfileId: 1 } });
  const connection = await lidarrClient.testConnection();
  assert.notEqual(connection.connected, true);
  assert.deepEqual(lidarr.state.artists, []);
});

test("Aurral searches, queues, and cancels slskd downloads through the Lab fixture", async (t) => {
  const apiKey = "lab-slskd-key";
  const slskd = createSlskd(catalog, { apiKey });
  const url = await serve(t, slskd);
  const artist = catalog.artists.find((entry) => entry.albums.some((album) => album.tracks.length > 1));
  const album = artist.albums.find((entry) => entry.tracks.length > 1);
  configure({ slskd: { enabled: true, url, apiKey } });

  const connection = await slskdClient.testConnection({ force: true });
  assert.equal(connection.connected, true);
  assert.ok(connection.downloadPath);

  const search = await slskdClient.createSearch(`${artist.name} ${album.title}`);
  const result = await slskdClient.getSearch(search.id);
  const files = result.responses.flatMap((response) => response.files);
  assert.equal(files.length, album.tracks.length);
  assert.ok(album.tracks.every((title) => files.some((file) => file.filename.includes(title))));
  assert.deepEqual((await slskdClient.createSearch(`${artist.name} not in the catalog`).then(({ id }) => slskdClient.getSearch(id))).responses, []);

  const queued = await slskdClient.enqueueBatch({ username: result.responses[0].username, files: [files[0]] });
  const transfer = await slskdClient.getTransfer(result.responses[0].username, queued.transferId);
  assert.match(transfer.state, /Queued/);
  assert.equal(await slskdClient.deleteTransfer(result.responses[0].username, queued.transferId), true);
  assert.equal(await slskdClient.getTransfer(result.responses[0].username, queued.transferId), null);
  assert.deepEqual(slskd.state.transfers, []);

  configure({ slskd: { enabled: true, url, apiKey: "wrong-key" } });
  assert.notEqual((await slskdClient.testConnection({ force: true })).connected, true);
});
