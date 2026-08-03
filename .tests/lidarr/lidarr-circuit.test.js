import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { LidarrClient } from "../../backend/services/lidarrClient.js";

test("isCircuitOpen returns stale GET cache instead of throwing", async () => {
  const client = new LidarrClient();
  client.config = { url: "http://localhost:8686", apiKey: "test", circuitDisabled: false };
  client._circuitOpen = true;
  client._circuitOpenedAt = Date.now();
  client._artistListCache = { data: [{ id: 1, artistName: "Test" }], at: 0 };

  assert.equal(client.isCircuitOpen(), true);
  const artists = await client.request("/artist", "GET", null, true);
  assert.equal(artists.length, 1);
  assert.equal(artists[0].artistName, "Test");
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
