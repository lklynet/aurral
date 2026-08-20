import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { dbOps } from "../../backend/db/helpers/index.js";
import { LidarrClient } from "../../backend/services/lidarrClient.js";

test("isCircuitOpen returns stale GET cache instead of throwing", async () => {
  const client = new LidarrClient();
  client.config = {
    url: "http://localhost:8686",
    apiKey: "test",
    circuitDisabled: false,
  };
  client._circuitOpen = true;
  client._circuitOpenedAt = Date.now();
  client._artistListCache = { data: [{ id: 1, artistName: "Test" }], at: 0 };

  assert.equal(client.isCircuitOpen(), true);
  const artists = await client.request("/artist", "GET", null, true);
  assert.equal(artists.length, 1);
  assert.equal(artists[0].artistName, "Test");
});

test("bulk track reads use Lidarr artist selectors", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ id: 1, albumId: 2 }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  await client.getAllTracks({ artistIds: [7, 8], throwOnError: true });
  await client.getAllTrackFiles({ artistIds: [7, 8], throwOnError: true });

  assert.deepEqual(requests.sort(), [
    "/api/v1/track?artistId=7",
    "/api/v1/track?artistId=8",
    "/api/v1/trackfile?artistId=7",
    "/api/v1/trackfile?artistId=8",
  ]);
  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("bulk reads wait for active requests before failing", async () => {
  const client = new LidarrClient();
  const artistIds = Array.from({ length: 14 }, (_, index) => index + 1);
  const started = [];
  let releaseFailure;
  let releasePending;
  let resolveInitialRequests;
  const failure = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const pending = new Promise((resolve) => {
    releasePending = resolve;
  });
  const initialRequests = new Promise((resolve) => {
    resolveInitialRequests = resolve;
  });

  client.request = async (endpoint) => {
    const artistId = Number(new URL(`http://localhost${endpoint}`).searchParams.get("artistId"));
    started.push(artistId);
    if (started.length === 12) resolveInitialRequests();
    if (artistId === 1) {
      await failure;
      throw new Error("bulk track read failed");
    }
    if (artistId <= 12) await pending;
    return [];
  };

  const read = client.getAllTracks({ artistIds, throwOnError: true });
  await initialRequests;
  releaseFailure();

  let settled = false;
  const rejection = read.catch((error) => {
    settled = true;
    throw error;
  });
  await delay(10);
  assert.equal(settled, false);

  releasePending();
  await assert.rejects(rejection, /bulk track read failed/);
  await delay(0);
  assert.deepEqual(started, artistIds.slice(0, 12));
});

test("bulk track-file reads use bounded repeated ID selectors", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push(url.searchParams.getAll("trackFileIds").map(Number));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  await client.getTrackFilesByIds(
    Array.from({ length: 401 }, (_, index) => index + 1),
    { throwOnError: true },
  );

  assert.deepEqual(
    requests.map((batch) => batch.length).sort((left, right) => left - right),
    [1, 400],
  );
  assert.deepEqual(requests.flat().sort((left, right) => left - right), [
    ...Array.from({ length: 401 }, (_, index) => index + 1),
  ]);
  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("testConnection preserves Lidarr HTTP diagnostics", async (t) => {
  let status = 401;
  const server = http.createServer((_request, response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "x-test-header": String(status),
    });
    response.end(JSON.stringify({ message: `failure-${status}` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  let result = await client.testConnection(true);
  assert.equal(result.statusCode, 401);
  assert.match(result.details, /failure-401/);
  assert.equal(result.responseHeaders["x-test-header"], "401");

  status = 500;
  result = await client.testConnection(true);
  assert.equal(result.statusCode, 500);
  assert.match(result.details, /failure-500/);
  assert.equal(result.responseHeaders["x-test-header"], "500");

  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("getAlbumByMbid avoids unrelated broken albums in Lidarr", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/api/v1/album") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Sequence contains more than one element" }));
      return;
    }
    if (request.url === "/api/v1/album?foreignAlbumId=missing-album") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  const album = await client.getAlbumByMbid("missing-album", { forceRefresh: true });

  assert.equal(album, undefined);
  assert.deepEqual(requests, ["/api/v1/album?foreignAlbumId=missing-album"]);
  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("getAlbumByMbid selects the matching album from filtered results", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/v1/album?foreignAlbumId=target-album") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        { id: 1, foreignAlbumId: "other-album" },
        { id: 2, foreignAlbumId: "TARGET-ALBUM" },
      ]),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  const album = await client.getAlbumByMbid("target-album");

  assert.equal(album?.id, 2);
  assert.equal(album?.foreignAlbumId, "TARGET-ALBUM");
  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("getAlbumByMbid accepts wrapped Lidarr album results", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/v1/album?foreignAlbumId=wrapped-album") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        records: [
          {
            id: 42,
            artistId: 7,
            foreignAlbumId: "wrapped-album",
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };

  const album = await client.getAlbumByMbid("wrapped-album", { forceRefresh: true });

  assert.equal(album?.id, 42);
  assert.equal(album?.artistId, 7);
  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("getAlbumsByMbidsSettled bounds concurrent lookups and preserves failures", async (t) => {
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  let active = 0;
  let maxActive = 0;
  client.getAlbumByMbid = async (albumMbid) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
    if (albumMbid === "album-7") throw new Error("lookup failed");
    return { foreignAlbumId: albumMbid };
  };

  const results = await client.getAlbumsByMbidsSettled(
    Array.from({ length: 8 }, (_, index) => `album-${index}`),
  );

  assert.equal(maxActive, 6);
  assert.equal(results[0].value.foreignAlbumId, "album-0");
  assert.equal(results[7].status, "rejected");
  assert.equal(results[7].reason.message, "lookup failed");
});

test("album-only artist add queues a search for the selected album", async (t) => {
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  let postedArtist;
  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });
  client.request = async (endpoint, method, payload) => {
    assert.equal(endpoint, "/artist");
    assert.equal(method, "POST");
    postedArtist = payload;
    return { id: 7, ...payload, monitored: true };
  };

  await client.addArtist("artist-mbid", "Boards of Canada", {
    albumOnly: true,
    albumMbid: "album-mbid",
    triggerSearch: true,
    metadataProfileId: 1,
  });

  assert.deepEqual(postedArtist.addOptions.albumsToMonitor, ["album-mbid"]);
  assert.equal(postedArtist.addOptions.searchForMissingAlbums, true);
});

test("artist add resolves a non-numeric Lidarr response ID before follow-up calls", async (t) => {
  const artistMbid = "f1693075-b637-49f8-8d0e-8cee8bec77cb";
  const requests = [];
  let updatePayload;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.method === "POST" && request.url === "/api/v1/artist") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: artistMbid,
          foreignArtistId: artistMbid,
          artistName: "Lena Raine",
          monitored: false,
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/artist") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: 42,
            foreignArtistId: artistMbid,
            artistName: "Lena Raine",
            monitored: false,
          },
        ]),
      );
      return;
    }
    if (request.method === "GET" && request.url === `/api/v1/artist/${artistMbid}`) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: `The input string '${artistMbid}' was not in a correct format.`,
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/artist/42") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: 42,
          foreignArtistId: artistMbid,
          artistName: "Lena Raine",
          monitored: false,
        }),
      );
      return;
    }
    if (request.method === "PUT" && request.url === "/api/v1/artist/42") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        updatePayload = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 42,
            foreignArtistId: artistMbid,
            artistName: "Lena Raine",
            monitored: true,
          }),
        );
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };
  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });

  const artist = await client.addArtist(artistMbid, "Lena Raine", {
    metadataProfileId: 1,
  });

  assert.equal(artist.id, 42);
  assert.equal(artist.monitored, true);
  assert.equal(updatePayload.monitored, true);
  assert.equal(requests.includes(`/api/v1/artist/${artistMbid}`), false);
  assert.deepEqual(requests, [
    "/api/v1/artist",
    "/api/v1/artist",
    "/api/v1/artist/42",
    "/api/v1/artist/42",
  ]);

  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("artist add retries with the active metadata provider ID after a UUID format error", async (t) => {
  const artistMbid = "9c9f1380-2516-4fc9-a3e6-f9f61941d090";
  const requests = [];
  let providerPayload;
  const client = new LidarrClient();
  t.after(() => {
    dbOps.deleteLidarrArtistIdMap(artistMbid);
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });
  client.resolveCanonicalArtistIdentity = async () => ({
    name: "Muse",
    providerIds: ["705@deezer"],
  });
  client.request = async (endpoint, method = "GET", payload) => {
    requests.push({ endpoint, method });
    if (endpoint === "/artist" && method === "POST") {
      if (payload.foreignArtistId === artistMbid) {
        throw new Error(
          `Lidarr API error: 500 - The input string '${artistMbid}' was not in a correct format.`,
        );
      }
      providerPayload = payload;
      return {
        id: 42,
        foreignArtistId: "705@deezer",
        artistName: "Muse",
        monitored: true,
      };
    }
    if (endpoint === "/artist" && method === "GET") {
      return [{ id: 42, foreignArtistId: "705@deezer", artistName: "Muse" }];
    }
    if (endpoint === `/artist/lookup?term=${encodeURIComponent("Muse")}` && method === "GET") {
      return [
        {
          foreignArtistId: "999@deezer",
          artistName: "Muse",
        },
        {
          foreignArtistId: "123@deezer",
          artistName: "Muse",
        },
      ];
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  const artist = await client.addArtist(artistMbid, "Muse", {
    metadataProfileId: 1,
  });

  assert.equal(artist.id, 42);
  assert.equal(providerPayload.foreignArtistId, "705@deezer");
  assert.equal(dbOps.getLidarrArtistIdMap(artistMbid), "705@deezer");
  assert.equal((await client.getArtistByMbid(artistMbid, { forceRefresh: true })).id, 42);
  assert.deepEqual(requests, [
    { endpoint: "/artist", method: "POST" },
    { endpoint: `/artist/lookup?term=${encodeURIComponent("Muse")}`, method: "GET" },
    { endpoint: "/artist", method: "POST" },
    { endpoint: "/artist", method: "GET" },
  ]);
});

test("artist add rejects a MusicBrainz ID and name mismatch", async (t) => {
  const artistMbid = "f1693075-b637-49f8-8d0e-8cee8bec77cb";
  const client = new LidarrClient();
  t.after(() => {
    dbOps.deleteLidarrArtistIdMap(artistMbid);
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });
  client.resolveCanonicalArtistIdentity = async () => ({
    name: "Radiohead",
    providerIds: ["399@deezer"],
  });
  let postCount = 0;
  client.request = async (endpoint, method = "GET") => {
    if (endpoint === "/artist" && method === "POST") {
      postCount += 1;
      throw new Error(
        `Lidarr API error: 500 - The input string '${artistMbid}' was not in a correct format.`,
      );
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  await assert.rejects(
    client.addArtist(artistMbid, "Muse", { metadataProfileId: 1 }),
    /does not match the requested artist name/,
  );
  assert.equal(postCount, 1);
  assert.equal(dbOps.getLidarrArtistIdMap(artistMbid), null);
});

test("artist add accepts a MusicBrainz alias when resolving a provider ID", async (t) => {
  const artistMbid = "c5c3e287-d2a7-497f-a212-e2cfb7bcb90c";
  const providerArtistId = "181216727@deezer";
  const client = new LidarrClient();
  t.after(() => {
    dbOps.deleteLidarrArtistIdMap(artistMbid);
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });
  client.resolveCanonicalArtistIdentity = async () => ({
    name: "FromSoftware",
    aliases: ["From Software"],
    providerIds: [providerArtistId],
  });
  client.request = async (endpoint, method = "GET", payload) => {
    if (endpoint === "/artist" && method === "POST") {
      if (payload.foreignArtistId === artistMbid) {
        throw new Error(
          `Lidarr API error: 500 - The input string '${artistMbid}' was not in a correct format.`,
        );
      }
      return {
        id: 42,
        foreignArtistId: providerArtistId,
        artistName: "FromSoftware",
        monitored: true,
      };
    }
    if (endpoint === "/artist" && method === "GET") {
      return [{ id: 42, foreignArtistId: providerArtistId, artistName: "FromSoftware" }];
    }
    if (
      endpoint === `/artist/lookup?term=${encodeURIComponent("FromSoftware")}` &&
      method === "GET"
    ) {
      return [{ foreignArtistId: providerArtistId, artistName: "FromSoftware" }];
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  const artist = await client.addArtist(artistMbid, "From Software", {
    metadataProfileId: 1,
  });

  assert.equal(artist.id, 42);
  assert.equal(dbOps.getLidarrArtistIdMap(artistMbid), providerArtistId);
});

test("artist add succeeds when a provider mapping conflict follows a successful POST", async (t) => {
  const artistMbid = "mapping-conflict-add-mbid";
  const existingMbid = "mapping-conflict-existing-mbid";
  const providerId = "mapping-conflict-provider@deezer";
  const client = new LidarrClient();
  t.after(() => {
    dbOps.deleteLidarrArtistIdMap(artistMbid);
    dbOps.deleteLidarrArtistIdMap(existingMbid);
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  dbOps.setLidarrArtistIdMap(existingMbid, providerId);
  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });
  client.resolveCanonicalArtistIdentity = async () => ({
    name: "Muse",
    providerIds: [providerId],
  });
  client.request = async (endpoint, method = "GET", payload) => {
    if (endpoint === "/artist" && method === "POST") {
      if (payload.foreignArtistId === artistMbid) {
        throw new Error(
          `Lidarr API error: 500 - The input string '${artistMbid}' was not in a correct format.`,
        );
      }
      assert.equal(payload.foreignArtistId, providerId);
      return { id: 42, foreignArtistId: providerId, artistName: "Muse", monitored: true };
    }
    if (endpoint === `/artist/lookup?term=${encodeURIComponent("Muse")}` && method === "GET") {
      return [{ foreignArtistId: providerId, artistName: "Muse" }];
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  const artist = await client.addArtist(artistMbid, "Muse", { metadataProfileId: 1 });

  assert.equal(artist.id, 42);
  assert.equal(dbOps.getLidarrArtistMbid(providerId), existingMbid);
});

test("Lidarr artist provider mappings reject reverse-ID conflicts", async (t) => {
  const firstMbid = "mapping-first-mbid";
  const secondMbid = "mapping-second-mbid";
  const providerId = "mapping-provider-id@deezer";
  t.after(() => {
    dbOps.deleteLidarrArtistIdMap(firstMbid);
    dbOps.deleteLidarrArtistIdMap(secondMbid);
  });

  dbOps.setLidarrArtistIdMap(firstMbid, providerId);
  assert.throws(
    () => dbOps.setLidarrArtistIdMap(secondMbid, providerId),
    (error) =>
      error.code === "LIDARR_ARTIST_ID_CONFLICT" &&
      /already mapped to another MusicBrainz artist/.test(error.message),
  );
  assert.equal(dbOps.getLidarrArtistMbid(providerId), firstMbid);
});

test("artist add fails when Lidarr cannot resolve a numeric ID", async (t) => {
  const artistMbid = "f1693075-b637-49f8-8d0e-8cee8bec77cb";
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });

  let postCount = 0;
  let lookupCount = 0;
  client.request = async (endpoint, method, _payload, _skipConfigUpdate, options) => {
    if (endpoint === "/artist" && method === "POST") {
      postCount += 1;
      return {
        id: artistMbid,
        foreignArtistId: artistMbid,
        artistName: "Lena Raine",
      };
    }
    if (endpoint === "/artist" && method === "GET") {
      lookupCount += 1;
      if (lookupCount === 2) {
        assert.equal(options.forceRefresh, true);
      }
      return [];
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  await assert.rejects(
    client.addArtist(artistMbid, "Lena Raine", {
      metadataProfileId: 1,
      monitorOption: "all",
    }),
    /numeric artist ID/,
  );

  assert.equal(postCount, 1);
  assert.equal(lookupCount, 2);
});

test("artist add does not retry creation after monitoring fails", async (t) => {
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });

  client.resolveArtistAddConfiguration = async () => ({
    resolved: {
      rootFolderPath: "/music",
      qualityProfileId: 1,
    },
  });

  let postCount = 0;
  client.request = async (endpoint, method = "GET") => {
    if (endpoint === "/artist" && method === "POST") {
      postCount += 1;
      return {
        id: 42,
        foreignArtistId: "artist-mbid",
        artistName: "Lena Raine",
        monitored: false,
      };
    }
    if (endpoint === "/artist/42" && method === "GET") {
      return {
        id: 42,
        foreignArtistId: "artist-mbid",
        artistName: "Lena Raine",
        monitored: false,
      };
    }
    if (endpoint === "/artist/42" && method === "PUT") {
      throw new Error("monitoring failed");
    }
    throw new Error(`Unexpected Lidarr request: ${method} ${endpoint}`);
  };

  await assert.rejects(
    client.addArtist("artist-mbid", "Lena Raine", {
      metadataProfileId: 1,
      monitorOption: "all",
    }),
    /monitoring failed/,
  );

  assert.equal(postCount, 1);
});

test("Lidarr cooldown permits only one half-open recovery request", async (t) => {
  const firstRequest = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  let requestCount = 0;
  const server = http.createServer(async (_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstRequest.resolve();
      await releaseFirst.promise;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: false,
  };
  client._circuitOpen = true;
  client._circuitOpenedAt = Date.now() - 61000;

  const probe = client.request("/probe-a", "GET", null, true);
  await firstRequest.promise;
  const waiting = [
    client.request("/probe-b", "GET", null, true),
    client.request("/probe-c", "GET", null, true),
  ];

  await delay(50);
  const requestsBeforeRecovery = requestCount;
  releaseFirst.resolve();
  await Promise.all([probe, ...waiting]);

  assert.equal(requestsBeforeRecovery, 1);
  assert.equal(requestCount, 3);
  assert.equal(client._circuitOpen, false);

  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});

test("a failed Lidarr recovery probe reopens the cooldown", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: false,
  };
  client._circuitOpen = true;
  client._circuitFailures = 3;
  client._lastCircuitFailureAt = Date.now() - 61000;
  client._circuitOpenedAt = Date.now() - 61000;

  await assert.rejects(client.request("/probe", "GET", null, true));
  const requestsAfterProbe = requestCount;
  await assert.rejects(
    client.request("/blocked-during-cooldown", "GET", null, true),
    /circuit open/,
  );

  assert.equal(requestCount, requestsAfterProbe);
  assert.equal(client.isCircuitOpen(), true);

  client._httpAgent.destroy();
  client._httpsAgent.destroy();
  client._httpsInsecureAgent.destroy();
});
