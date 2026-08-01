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
