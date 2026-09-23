import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { prowlarrClient },
  { downloadTracker },
  { processUsenetPipelinePayload },
  { nzbgetClient },
  { SabnzbdClient },
  { getEnabledDownloadSources },
  { rankUsenetReleases, selectRankedUsenetCandidates },
  { dbOps },
  { db },
] = await setupIsolatedBackend(
  "usenet-integration",
  "backend/services/prowlarrClient.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/nzbgetClient.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/downloadSourceService.js",
  "backend/services/weeklyFlow/weeklyFlowUsenetReleaseSearch.js",
  "backend/db/helpers/index.js",
  "backend/config/db-sqlite.js",
);

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("Prowlarr client lists enabled Usenet indexers and searches audio releases", async () => {
  const requests = [];
  const server = await createMockHttpServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers["x-api-key"], "prowlarr-key");
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/system/status") {
      sendJson(res, 200, { appName: "Prowlarr", version: "2.0.0" });
      return;
    }
    if (url.pathname === "/api/v1/indexer") {
      sendJson(res, 200, [
        {
          id: 1,
          name: "Music One",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 5,
          capabilities: { categories: [{ id: 3010 }] },
        },
        {
          id: 2,
          name: "Disabled In Aurral",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 10,
          capabilities: { categories: [{ id: 3000 }] },
        },
        {
          id: 3,
          name: "Torrent",
          enable: true,
          protocol: "torrent",
          supportsSearch: true,
          priority: 1,
          capabilities: { categories: [{ id: 3000 }] },
        },
        {
          id: 4,
          name: "Music Two",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 6,
          capabilities: { categories: [{ id: 3010 }] },
        },
      ]);
      return;
    }
    if (url.pathname === "/api/v1/search") {
      assert.equal(url.searchParams.get("type"), "search");
      assert.deepEqual(url.searchParams.getAll("indexerIds"), ["1", "4"]);
      assert.deepEqual(url.searchParams.getAll("categories"), ["3000"]);
      sendJson(res, 200, [
        {
          id: 99,
          guid: "release-guid",
          title: "Artist - Album (2024) FLAC",
          indexerId: 1,
          indexer: "Music One",
          protocol: "usenet",
          size: 123456789,
          downloadUrl: "/api/v1/indexer/1/download?link=abc",
          categories: [{ id: 3010 }],
          publishDate: "2024-01-01T00:00:00Z",
        },
      ]);
      return;
    }
    sendJson(res, 404, {});
  });

  try {
    dbOps.updateSettings({
      integrations: {
        prowlarr: {
          enabled: true,
          url: server.url,
          apiKey: "prowlarr-key",
          categories: [3000],
          maxResults: 50,
          indexers: {
            2: { enabled: false, priority: 10 },
          },
        },
      },
    });

    const status = await prowlarrClient.testConnection({ force: true });
    assert.equal(status.ok, true);
    assert.equal(status.usenetIndexerCount, 3);
    assert.equal(status.enabledUsenetIndexerCount, 2);

    const indexers = await prowlarrClient.getEnabledUsenetIndexers();
    assert.deepEqual(indexers.map((entry) => entry.id), [1, 4]);

    const releases = await prowlarrClient.search("Artist Album");
    assert.equal(releases.length, 1);
    assert.equal(releases[0].guid, "release-guid");
    assert.equal(
      releases[0].downloadUrl,
      `${server.url}/api/v1/indexer/1/download?link=abc`,
    );
    assert.ok(requests.some((entry) => entry.startsWith("/api/v1/search")));
  } finally {
    await server.close();
  }
});

test("Usenet flow search tries the album-only query after artist-album queries", async () => {
  const queries = [];
  const server = await createMockHttpServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/indexer") {
      sendJson(res, 200, [
        {
          id: 1,
          name: "Music One",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 5,
          capabilities: { categories: [{ id: 3010 }] },
        },
      ]);
      return;
    }
    if (url.pathname === "/api/v1/search") {
      queries.push(url.searchParams.get("query"));
      sendJson(res, 200, []);
      return;
    }
    sendJson(res, 404, {});
  });

  try {
    dbOps.updateSettings({
      integrations: {
        prowlarr: {
          enabled: true,
          url: server.url,
          apiKey: "prowlarr-key",
          categories: [3000],
        },
      },
    });
    const jobId = downloadTracker.addJob(
      {
        artistName: "Rihanna",
        trackName: "Umbrella",
        albumName: "Good Girl Gone Bad",
        releaseYear: "2007",
        durationMs: 250000,
      },
      "usenet-album-only-fallback",
    );

    const result = await processUsenetPipelinePayload(
      { phase: "search", source: "usenet", jobId },
      {
        failOrTryNextSource: (_payload, _job, message, details) => ({ message, details }),
      },
    );

    const albumOnlyIndex = queries.indexOf("Good Girl Gone Bad");
    const albumTrackIndex = queries.indexOf("Good Girl Gone Bad Umbrella");
    assert.ok(albumOnlyIndex > 0);
    assert.ok(albumTrackIndex > albumOnlyIndex);
    assert.ok(
      [
        "Rihanna Good Girl Gone Bad 2007",
        "Rihanna Good Girl Gone Bad",
        "*ihanna Good Girl Gone Bad 2007",
        "*ihanna Good Girl Gone Bad",
      ].every((query) => queries.indexOf(query) >= 0 && queries.indexOf(query) < albumOnlyIndex),
    );
    assert.equal(result.message, "No suitable Usenet search results");
    assert.equal(result.details.queryCount, queries.length);
  } finally {
    await server.close();
  }
});

test("NZBGet client uses JSON-RPC append signature and exposes completed paths", async () => {
  const calls = [];
  const server = await createMockHttpServer((req, res) => {
    if (req.url !== "/jsonrpc") {
      sendJson(res, 404, {});
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      calls.push(payload);
      let result = null;
      if (payload.method === "version") result = "24.3";
      if (payload.method === "status") {
        result = { DownloadPaused: false, DownloadRateLo: 0 };
      }
      if (payload.method === "config") {
        result = [{ Name: "DestDir", Value: "/downloads/complete" }];
      }
      if (payload.method === "append") result = 42;
      if (payload.method === "listgroups") {
        result = [{ NZBID: 42, Status: "DOWNLOADING" }];
      }
      if (payload.method === "history") {
        result = [{ NZBID: 42, Status: "SUCCESS/ALL", FinalDir: "/done" }];
      }
      sendJson(res, 200, { jsonrpc: "2.0", id: payload.id, result });
    });
  });

  try {
    dbOps.updateSettings({
      integrations: {
        nzbget: {
          enabled: true,
          url: server.url,
          username: "user",
          password: "pass",
          category: "aurral",
          priority: 15,
          nzbPriority: 50,
          completedPath: "/configured/done",
        },
      },
    });

    const status = await nzbgetClient.testConnection({ force: true });
    assert.equal(status.ok, true);
    assert.equal(status.downloadPath, "/configured/done");

    const appended = await nzbgetClient.appendUrl({
      name: "Artist - Album",
      url: "https://example.test/file.nzb",
    });
    assert.equal(appended.nzbId, 42);
    const appendCall = calls.find((call) => call.method === "append");
    assert.equal(appendCall.params.length, 11);
    assert.equal(appendCall.params[0], "Artist - Album.nzb");
    assert.equal(appendCall.params[1], "https://example.test/file.nzb");
    assert.equal(appendCall.params[2], "aurral");
    assert.equal(appendCall.params[3], 50);

    assert.equal((await nzbgetClient.getQueueItem(42)).Status, "DOWNLOADING");
    assert.equal((await nzbgetClient.getHistoryItem(42)).Status, "SUCCESS/ALL");
  } finally {
    await server.close();
  }
});

test("SABnzbd client reads the completed download folder", async () => {
  const client = new SabnzbdClient();
  client.api = async () => ({
    config: { misc: { complete_dir: "/downloads/complete" } },
  });

  assert.equal(
    (await client.getDownloadDirectories()).destDir,
    "/downloads/complete",
  );
});

test("SABnzbd client removes queued and historical jobs", async () => {
  const calls = [];
  const client = new SabnzbdClient();
  client.api = async (mode, params) => {
    calls.push({ mode, params });
    return { status: true };
  };

  assert.equal(await client.deleteQueueItem("SABnzbd_nzo_queue"), true);
  assert.equal(await client.deleteHistoryItem("SABnzbd_nzo_history"), true);
  assert.deepEqual(calls, [
    {
      mode: "queue",
      params: { name: "delete", value: "SABnzbd_nzo_queue", del_files: 1 },
    },
    {
      mode: "history",
      params: { name: "delete", value: "SABnzbd_nzo_history", del_files: 1 },
    },
  ]);
});

test("SABnzbd client does not claim a failed queue or history deletion succeeded", async () => {
  const client = new SabnzbdClient();
  client.api = async () => ({ status: false });

  assert.equal(await client.deleteQueueItem("SABnzbd_nzo_queue"), false);
  assert.equal(await client.deleteHistoryItem("SABnzbd_nzo_history"), false);
});

test("download source selection orders enabled sources by priority", () => {
  dbOps.updateSettings({
    integrations: {
      slskd: {
        enabled: true,
        url: "http://slskd.local",
        apiKey: "slskd-key",
        priority: 30,
      },
      prowlarr: {
        enabled: true,
        url: "http://prowlarr.local",
        apiKey: "prowlarr-key",
      },
      nzbget: {
        enabled: true,
        url: "http://nzbget.local",
        priority: 5,
      },
      ytdlp: {
        enabled: false,
      },
    },
  });

  assert.deepEqual(
    getEnabledDownloadSources().map((source) => source.id),
    ["usenet", "slskd"],
  );
});

test("Usenet matcher prefers matching audio releases and keeps fallback candidates", () => {
  const context = {
    artistName: "Example Artist",
    trackName: "Signal Fire",
    albumName: "Bright Static",
    releaseYear: "2024",
    albumTrackCount: 10,
  };
  const ranked = rankUsenetReleases(
    [
      {
        title: "Example Artist - Bright Static (2024) FLAC",
        protocol: "usenet",
        downloadUrl: "https://indexer/download/1",
        indexerId: 1,
        indexer: "Music",
        categories: [3010],
        size: 450 * 1024 * 1024,
      },
      {
        title: "Unrelated Video Collection",
        protocol: "usenet",
        downloadUrl: "https://indexer/download/2",
        indexerId: 2,
        categories: [2000],
        size: 500 * 1024 * 1024,
      },
    ],
    context,
  );

  assert.equal(ranked[0].raw.release.title, "Example Artist - Bright Static (2024) FLAC");
  assert.equal(ranked[0].releaseAdmissible, true);
  const selected = selectRankedUsenetCandidates(ranked, 2);
  assert.equal(selected.length, 2);
});
