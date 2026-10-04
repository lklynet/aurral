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
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/usenetOrchestrator.js",
  "backend/services/nzbgetClient.js",
  "backend/services/sabnzbdClient.js",
  "backend/services/downloadSourceService.js",
  "backend/services/downloadJobs/usenetReleaseSearch.js",
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

async function searchUntilDone(payload, helpers) {
  let result = payload;
  while (result?.phase === "search") result = await processUsenetPipelinePayload(result, helpers);
  return result;
}

test("Usenet searches like Lidarr: a music search where supported, then cleaned text", async () => {
  const requests = [];
  const server = await createMockHttpServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    if (url.pathname === "/api/v1/indexer") {
      sendJson(res, 200, [
        { id: 1, name: "Music Search", enable: true, protocol: "usenet", supportsSearch: true, priority: 5,
          capabilities: { categories: [{ id: 3010 }], musicSearchParams: ["q", "artist", "album"] } },
        { id: 2, name: "Text Only", enable: true, protocol: "usenet", supportsSearch: true, priority: 6,
          capabilities: { categories: [{ id: 3010 }], musicSearchParams: ["q"] } },
      ]);
      return;
    }
    if (url.pathname === "/api/v1/search") {
      requests.push({ query: url.searchParams.get("query"), type: url.searchParams.get("type"),
        indexerIds: url.searchParams.getAll("indexerIds") });
      sendJson(res, 200, []);
      return;
    }
    sendJson(res, 404, {});
  });

  try {
    dbOps.updateSettings({
      integrations: {
        prowlarr: { enabled: true, url: server.url, apiKey: "prowlarr-key", categories: [3000] },
      },
    });
    const jobId = downloadTracker.addJob({
      artistName: "AC/DC", trackName: "Hells Bells", albumName: "Back in Black (Remastered)",
      releaseYear: "1980", durationMs: 312000,
    }, "usenet-lidarr-plan");

    const result = await searchUntilDone({ phase: "search", source: "usenet", jobId },
      { failOrTryNextSource: (_payload, _job, message, details) => ({ message, details }) });

    assert.deepEqual(requests, [
      { query: "{artist:AC DC}{album:Back in Black}", type: "music", indexerIds: ["1"] },
      { query: "AC DC Back in Black", type: "search", indexerIds: ["1", "2"] },
      { query: "AC DC Hells Bells", type: "search", indexerIds: ["1", "2"] },
    ]);
    assert.equal(result.message, "No suitable Usenet search results");
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
    assert.equal(appendCall.params[8], "FORCE");

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

for (const albumGrab of [false, true]) {
  test(`Usenet continues past ${albumGrab ? "track-only album-grab" : "denied"} results`, async (t) => {
    t.mock.method(prowlarrClient, "getEnabledUsenetIndexers", async () => [{ id: 1, musicSearch: true }]);
    const artist = albumGrab ? "The Bend" : "The Band";
    const jobId = downloadTracker.addJob({ artistName: artist, trackName: "First",
      albumName: "Album", durationMs: 180000 }, "usenet-exclusions");
    if (!albumGrab) {
      for (const id of ["first-1", "first-2"]) downloadTracker.recordDeniedSource(jobId, "usenet", id);
    }
    const originalDenials = structuredClone(downloadTracker.getJob(jobId).deniedRemoteSources);
    const original = prowlarrClient.search;
    let searches = 0;
    prowlarrClient.search = async () => {
      const first = ++searches === 1;
      return [1, 2].map((index) => ({ guid: `${first ? "first" : "allowed"}-${index}`,
        title: `${artist} - ${first ? "First" : "Album"} FLAC`, protocol: "usenet",
        downloadUrl: `https://release.invalid/${first}/${index}`, indexerId: index, size: 100000000 }));
    };
    try {
      const result = await searchUntilDone({ phase: "search", source: "usenet", jobId, albumGrab }, {
        failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }),
      });
      assert.equal(result.phase, "download");
      assert.deepEqual(result.candidates.map((entry) => entry.raw.guid), ["allowed-1", "allowed-2"]);
      assert.deepEqual(downloadTracker.getJob(jobId).deniedRemoteSources,
        originalDenials);
    } finally {
      prowlarrClient.search = original;
    }
  });
}

test("a Usenet search runs one Prowlarr query per pipeline step", async (t) => {
  for (const [name, results, error] of [
    ["Step", async () => [], "No suitable Usenet search results"],
    ["Down", async () => { throw new Error("indexer down"); }, "Prowlarr search failed: indexer down"],
  ]) {
    const search = t.mock.method(prowlarrClient, "search", results);
    const jobId = downloadTracker.addJob({ artistName: `${name} Artist`, trackName: `${name} Song`,
      albumName: `${name} Album`, durationMs: 180000 }, "usenet-steps");
    const helpers = { failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }) };
    let payload = { phase: "search", source: "usenet", jobId };
    let steps = 0;
    while (payload?.phase === "search" && steps < 20) {
      const before = search.mock.callCount();
      payload = await processUsenetPipelinePayload(payload, helpers);
      assert.ok(search.mock.callCount() - before <= 1);
      steps += 1;
    }
    assert.equal(payload.error, error);
    assert.equal(steps, search.mock.callCount());
    search.mock.restore();
  }
});

test("a Usenet compilation grab searches as VA and by its title, never by a track artist", async (t) => {
  t.mock.method(prowlarrClient, "getEnabledUsenetIndexers", async () => [{ id: 1, musicSearch: true }]);
  const search = t.mock.method(prowlarrClient, "search", async () => []);
  const ids = [["Blue Swede", "Hooked on a Feeling"], ["Raspberries", "Go All the Way"]]
    .map(([artistName, trackName], index) => downloadTracker.addJob({
      artistName, trackName, trackNumber: index + 1, durationMs: 180000,
      albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack",
      albumMbid: "usenet-compilation", requestGroupId: "usenet-compilation",
    }, "library"));
  await searchUntilDone({ phase: "search", source: "usenet", jobId: ids[0], albumGrab: true,
    albumGroupJobIds: ids }, { failOrTryNextSource: (_payload, _job, reason) => ({ error: reason }) });
  assert.deepEqual(search.mock.calls.map((call) => call.arguments[0]), [
    "VA Guardians of the Galaxy Awesome Mix Vol 1",
    "Guardians of the Galaxy Awesome Mix Vol 1",
  ]);
});

function admitted(titles, context) {
  const releases = titles.map((title, index) => ({ title, guid: `guid-${index}`, downloadUrl: `https://nzb.invalid/${index}`,
    protocol: "usenet", size: 300 * 1024 * 1024, categories: [3010] }));
  return rankUsenetReleases(releases, context)
    .filter((entry) => entry.releaseAdmissible)
    .map((entry) => [entry.raw.release.title, entry.resolvedAlbumName ? "album" : "track"]);
}

test("Usenet release titles match by their words, not by overall similarity", () => {
  const lemonade = admitted([
    "Beyoncé feat. Kendrick Lamar - Lemonade (2016) MP3",
    "Beyonce - LEMONADE (2016)-NoGroup",
    "Lemonade Mouth - Original Soundtrack (2011)",
  ], { artistName: "Beyoncé", albumName: "Lemonade", trackName: "Formation" });
  assert.deepEqual(lemonade.map(([title]) => title).sort(), [
    "Beyonce - LEMONADE (2016)-NoGroup",
    "Beyoncé feat. Kendrick Lamar - Lemonade (2016) MP3",
  ]);

  const soundtrack = admitted([
    "VA-Guardians Of The Galaxy Awesome Mix Vol.1-OST-CD-FLAC-2014-CHS",
    "Guardians Of The Galaxy Awesome Mix Vol. 1-OST-2014-iTS",
    "Blue Swede - Hooked on a Feeling (1974)",
  ], { artistName: "Blue Swede", compilation: true, trackName: "Hooked on a Feeling",
    albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack" });
  assert.deepEqual(soundtrack.map(([, kind]) => kind), ["album", "album"]);

  const selfTitled = admitted([
    "Portishead - Discography 1994-2008 FLAC",
    "Portishead - Portishead (1997) FLAC",
  ], { artistName: "Portishead", albumName: "Portishead", trackName: "Humming" });
  assert.deepEqual(selfTitled.map(([title]) => title), ["Portishead - Portishead (1997) FLAC"]);

  const bookends = admitted([
    "Simon and Garfunkel - Bookends (1968) FLAC",
    "Simon & Garfunkel - Bookends (1968) MP3",
  ], { artistName: "Simon & Garfunkel", albumName: "Bookends", trackName: "America" });
  assert.equal(bookends.length, 2);
});

test("a Usenet single in another version is not offered for the original track", () => {
  const releases = admitted([
    "Daft Punk Pharrell Williams Nile Rodgers-Get Lucky Daft Punk Remix -24BIT-WEBFLAC-2013-STASIAUDIO",
    "Daft Punk Pharrell Williams Nile Rodgers-Get Lucky Radio Edit -24BIT-WEBFLAC-2013-STASIAUDIO",
    "Daft Punk - Get Lucky (feat. Pharrell Williams) [2013] FLAC",
    "Daft Punk - Random Access Memories (2013) FLAC",
  ], { artistName: "Daft Punk", albumName: "Random Access Memories", trackName: "Get Lucky" });
  assert.deepEqual(releases.map(([title, kind]) => `${kind}: ${title}`).sort(), [
    "album: Daft Punk - Random Access Memories (2013) FLAC",
    "track: Daft Punk - Get Lucky (feat. Pharrell Williams) [2013] FLAC",
  ]);
});

test("a compilation track takes a single by its own artist from Usenet", () => {
  const context = { artistName: "Various Artists", artistAliases: ["Blue Swede"], trackName: "Hooked on a Feeling",
    albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1" };
  assert.deepEqual(admitted([
    "Blue Swede - Hooked on a Feeling (1974)",
    "Redbone - Come and Get Your Love (1974)",
  ], context), [["Blue Swede - Hooked on a Feeling (1974)", "track"]]);
});
