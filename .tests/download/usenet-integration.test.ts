import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createTrackedJob, trackedJob, usenetCandidate } from "./fixtures.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.ts";
import { OTHER_VERSION_LABELS, SAME_VERSION_LABELS } from "../track-matching/version-labels.ts";

const [
  isolatedState,
  { prowlarrClient },
  { downloadTracker },
  { processUsenetPipelinePayload },
  { nzbgetClient },
  { SabnzbdClient, sabnzbdClient, tidarrClient },
  { getEnabledDownloadSources },
  { rankUsenetReleases, selectRankedUsenetCandidates },
  { dbOps },
  { db },
] = await setupIsolatedBackend(
  "usenet-integration",
  () => import("../../backend/services/prowlarrClient.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/usenetOrchestrator.ts"),
  () => import("../../backend/services/nzbgetClient.ts"),
  () => import("../../backend/services/sabnzbdClient.ts"),
  () => import("../../backend/services/downloadSourceService.ts"),
  () => import("../../backend/services/downloadJobs/usenetReleaseSearch.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
);

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("Prowlarr client lists enabled Usenet indexers and searches audio releases", async () => {
  const requests: (string | undefined)[] = [];
  const server = await createMockHttpServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers["x-api-key"], "prowlarr-key");
    const url = new URL(req.url || "/", "http://mock");
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
    assert.deepEqual(
      indexers.map((entry) => entry.id),
      [1, 4],
    );

    const releases = await prowlarrClient.search("Artist Album");
    assert.equal(releases.length, 1);
    assert.equal(releases[0].guid, "release-guid");
    assert.equal(releases[0].downloadUrl, `${server.url}/api/v1/indexer/1/download?link=abc`);
    assert.ok(requests.some((entry) => entry?.startsWith("/api/v1/search")));
  } finally {
    await server.close();
  }
});

function useProwlarr(url: string) {
  dbOps.updateSettings({
    integrations: { prowlarr: { enabled: true, url, apiKey: "prowlarr-key" } },
  });
}

test("Prowlarr search skips a release Aurral can't read and keeps the rest", async () => {
  const server = await createMockHttpServer((req, res) => {
    const url = new URL(req.url || "/", "http://mock");
    if (url.pathname === "/api/v1/indexer") {
      sendJson(res, 200, [{ id: 1, name: "Music", enable: true, protocol: "usenet" }]);
      return;
    }
    sendJson(res, 200, [
      {
        guid: "bad",
        title: "Artist - Album MP3",
        size: "big",
        protocol: "usenet",
        downloadUrl: "/1",
      },
      {
        guid: "good",
        title: "Artist - Album FLAC",
        size: 1,
        protocol: "usenet",
        downloadUrl: "/2",
      },
    ]);
  });
  try {
    useProwlarr(server.url);
    const releases = await prowlarrClient.search("Artist Album");
    assert.deepEqual(
      releases.map((release) => release.guid),
      ["good"],
    );
  } finally {
    await server.close();
  }
});

test("Prowlarr connection test fails when something else answers at its address", async () => {
  const server = await createMockHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>Sign in</html>");
  });
  try {
    useProwlarr(server.url);
    const status = await prowlarrClient.testConnection({ force: true });
    assert.equal(status.connected, false);
    assert.match(status.message, /Prowlarr sent \/api\/v1\/system\/status data Aurral can't read/);
  } finally {
    await server.close();
  }
});

type UsenetPayload = Parameters<typeof processUsenetPipelinePayload>[0];
type UsenetResult = UsenetPayload & {
  error?: string;
  message?: string;
  details?: Record<string, number>;
};
type ProwlarrRelease = Awaited<ReturnType<typeof prowlarrClient.search>>[number];

function releaseFixture(release: Partial<ProwlarrRelease>): ProwlarrRelease {
  return {
    guid: null,
    title: "",
    size: 0,
    files: null,
    grabs: null,
    indexerId: null,
    indexer: null,
    publishDate: null,
    downloadUrl: "",
    protocol: "usenet",
    categories: [3010],
    ...release,
  };
}

const musicIndexer = {
  id: 1,
  musicSearch: true,
  name: "Music",
  protocol: "usenet",
  enabledInProwlarr: true,
  enabled: true,
  supportsSearch: true,
  priority: 1,
  categories: [3010],
} satisfies Awaited<ReturnType<typeof prowlarrClient.getEnabledUsenetIndexers>>[number];

async function runPipeline(payload: UsenetPayload): Promise<UsenetResult> {
  let failure: UsenetResult | undefined;
  const result = await processUsenetPipelinePayload(payload, {
    failOrTryNextSource: async (_payload, _job, message, details) => {
      failure = { ...payload, phase: "failed", error: message, message, details };
      return null;
    },
  });
  if (failure) return failure;
  assert.ok(result);
  assert.equal(result.jobId, payload.jobId);
  assert.equal(result.source, "usenet");
  return result as UsenetResult;
}

async function searchUntilDone(payload: UsenetPayload) {
  let result: UsenetResult = payload;
  while (result.phase === "search") result = await runPipeline(result);
  return result;
}

test("Usenet searches like Lidarr: a music search where supported, then cleaned text", async () => {
  const requests: { query: string | null; type: string | null; indexerIds: string[] }[] = [];
  const server = await createMockHttpServer((req, res) => {
    const url = new URL(req.url || "/", "http://mock");
    if (url.pathname === "/api/v1/indexer") {
      sendJson(res, 200, [
        {
          id: 1,
          name: "Music Search",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 5,
          capabilities: { categories: [{ id: 3010 }], musicSearchParams: ["q", "artist", "album"] },
        },
        {
          id: 2,
          name: "Text Only",
          enable: true,
          protocol: "usenet",
          supportsSearch: true,
          priority: 6,
          capabilities: { categories: [{ id: 3010 }], musicSearchParams: ["q"] },
        },
      ]);
      return;
    }
    if (url.pathname === "/api/v1/search") {
      requests.push({
        query: url.searchParams.get("query"),
        type: url.searchParams.get("type"),
        indexerIds: url.searchParams.getAll("indexerIds"),
      });
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
    const jobId = createTrackedJob(
      downloadTracker,
      {
        artistName: "AC/DC",
        trackName: "Hells Bells",
        albumName: "Back in Black (Remastered)",
        releaseYear: "1980",
        durationMs: 312000,
      },
      "usenet-lidarr-plan",
    );

    const result = await searchUntilDone({ phase: "search", source: "usenet", jobId });

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
  const calls: { method: string; params: [string, string, ...unknown[]] }[] = [];
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
      const payload: { method: string; id: number; params: [string, string, ...unknown[]] } =
        JSON.parse(body);
      calls.push(payload);
      let result: unknown = null;
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

    const appended = await nzbgetClient.appendNzb({
      name: "Artist - Album",
      content: Buffer.from("<nzb></nzb>"),
    });
    assert.equal(appended.nzbId, 42);
    const appendCall = calls.find((call) => call.method === "append");
    assert.ok(appendCall);
    assert.equal(appendCall.params.length, 11);
    assert.equal(appendCall.params[0], "Artist - Album.nzb");
    assert.equal(Buffer.from(appendCall.params[1], "base64").toString(), "<nzb></nzb>");
    assert.equal(appendCall.params[2], "aurral");
    assert.equal(appendCall.params[3], 50);
    assert.equal(appendCall.params[8], "FORCE");

    assert.deepEqual(await nzbgetClient.getQueueItem(42), { NZBID: 42, Status: "DOWNLOADING" });
    assert.deepEqual(await nzbgetClient.getHistoryItem(42), {
      NZBID: 42,
      Status: "SUCCESS/ALL",
      FinalDir: "/done",
    });
  } finally {
    await server.close();
  }
});

test("Aurral fetches a release's NZB itself and refuses an indexer error page", async () => {
  const server = await createMockHttpServer((req, res) => {
    if (req.url === "/1/download?apikey=key&link=good") {
      res.writeHead(200, { "Content-Type": "application/x-nzb" });
      res.end(
        '<?xml version="1.0"?><!DOCTYPE nzb><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>',
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>Daily download limit reached</body></html>");
  });
  try {
    const nzb = await prowlarrClient.downloadNzb(`${server.url}/1/download?apikey=key&link=good`);
    assert.match(nzb.toString(), /<nzb xmlns/);
    await assert.rejects(
      prowlarrClient.downloadNzb(`${server.url}/1/download?apikey=key&link=limit`),
      /did not return an NZB file/,
    );
  } finally {
    await server.close();
  }
});

test("SABnzbd client uploads the NZB file", async () => {
  const requests: { method: string | undefined; url: URL; body: string }[] = [];
  const server = await createMockHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: new URL(req.url || "/", "http://mock"),
        body: Buffer.concat(chunks).toString(),
      });
      sendJson(res, 200, { status: true, nzo_ids: ["SABnzbd_nzo_1"] });
    });
  });
  try {
    const client = new SabnzbdClient({
      enabled: true,
      url: server.url,
      apiKey: "sab-key",
      category: "music",
    });
    const appended = await client.appendNzb({
      name: "Artist - Album",
      content: Buffer.from("<nzb>release</nzb>"),
    });
    assert.equal(appended.nzbId, "SABnzbd_nzo_1");
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url.searchParams.get("mode"), "addfile");
    assert.equal(request.url.searchParams.get("nzbname"), "Artist - Album.nzb");
    assert.equal(request.url.searchParams.get("priority"), "-100");
    assert.match(request.body, /filename="Artist - Album\.nzb"/);
    assert.match(request.body, /<nzb>release<\/nzb>/);
  } finally {
    await server.close();
  }
});

test("SABnzbd client reads the completed download folder", async () => {
  const client = new SabnzbdClient({ category: "aurral" });
  client.api = async (_mode, params) =>
    params?.section === "categories"
      ? { config: { categories: [{ name: "aurral", dir: "music" }] } }
      : { config: { misc: { complete_dir: "/downloads/complete" } } };

  assert.deepEqual(await client.getDownloadDirectories(), {
    completedPath: "",
    categoryDestDir: "music",
    destDir: "/downloads/complete",
    interDir: "",
    mainDir: "",
  });
});

test("SABnzbd client removes queued and historical jobs", async () => {
  const calls: {
    mode: string;
    params: Record<string, string | number | null | undefined> | undefined;
  }[] = [];
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

test("Tidarr takes NZBs through the SABnzbd calls it answers", async () => {
  const modes: (string | null)[] = [];
  const server = await createMockHttpServer((req, res) => {
    const url = new URL(req.url || "/", "http://mock");
    const mode = url.searchParams.get("mode");
    modes.push(mode);
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (url.pathname !== "/api/sabnzbd/api") return sendJson(res, 404, {});
      if (mode === "version") return sendJson(res, 200, { version: "3.0.0" });
      if (mode === "get_config") {
        return sendJson(res, 200, {
          config: {
            categories: [{ name: "music", dir: "/downloads" }],
            misc: { complete_dir: "/downloads", download_dir: "/downloads", api_key: "" },
          },
        });
      }
      if (mode === "addfile") {
        const album = /Tidarr Album (\d+)\|/.exec(Buffer.concat(chunks).toString())?.[1];
        return sendJson(res, 200, { status: true, nzo_ids: [`tidarr_nzo_${album}`] });
      }
      sendJson(res, 400, { error: "Invalid mode" });
    });
  });
  try {
    const client = new SabnzbdClient(
      { enabled: true, url: server.url, apiKey: "tidarr-key" },
      "tidarr",
    );
    const status = await client.testConnection({ force: true });
    assert.equal(status.ok, true, status.message);
    assert.equal(status.downloadPath, "/downloads");
    const appended = await client.appendNzb({
      name: "Daft Punk - Discovery (2001) FLAC [WEB]-Tidarr (14 tracks)",
      content: Buffer.from(
        '<nzb><head><meta type="title">Tidarr Album 123|lossless</meta></head></nzb>',
      ),
    });
    assert.equal(appended.nzbId, "tidarr_nzo_123");
    assert.ok(modes.every((mode) => ["version", "get_config", "addfile"].includes(mode || "")));
  } finally {
    await server.close();
  }
});

test("an indexer's download client takes its releases, and other indexers keep the automatic one", async () => {
  const configure = (tidarrEnabled: boolean) =>
    dbOps.updateSettings({
      integrations: {
        prowlarr: {
          enabled: true,
          url: "http://prowlarr.local",
          apiKey: "prowlarr-key",
          indexers: { "2": { enabled: true, priority: 25, downloadClient: "tidarr" } },
        },
        sabnzbd: { enabled: true, url: "http://sabnzbd.local", apiKey: "sab-key" },
        tidarr: { enabled: tidarrEnabled, url: "http://tidarr.local", apiKey: "tidarr-key" },
      },
    });
  configure(true);
  const nzbRequests = vi
    .spyOn(prowlarrClient, "downloadNzb")
    .mockImplementation(async () => Buffer.from("<nzb/>"));
  vi.spyOn(sabnzbdClient, "appendNzb").mockImplementation(async () => ({
    nzbId: "SABnzbd_nzo_1",
    nzbName: "release.nzb",
  }));
  vi.spyOn(tidarrClient, "appendNzb").mockImplementation(async () => ({
    nzbId: "tidarr_nzo_123",
    nzbName: "release.nzb",
  }));
  const download = (indexerId: number, manualDownloadClient: string | null = null) =>
    runPipeline({
      phase: "download",
      source: "usenet",
      manualDownloadClient,
      jobId: createTrackedJob(
        downloadTracker,
        { artistName: "Daft Punk", trackName: "One More Time" },
        `indexer-client-${indexerId}-${manualDownloadClient}`,
      ),
      candidateIndex: 0,
      candidates: [
        usenetCandidate({
          raw: {
            release: releaseFixture({
              guid: `release-${indexerId}-${manualDownloadClient}`,
              title: "Daft Punk - Discovery FLAC",
              protocol: "usenet",
              downloadUrl: `http://prowlarr.local/${indexerId}/download`,
              indexerId,
            }),
          },
        }),
      ],
    });

  assert.equal((await download(1)).downloadClient, "sabnzbd");
  assert.equal((await download(2)).downloadClient, "tidarr");
  assert.equal((await download(2, "sabnzbd")).downloadClient, "tidarr");

  configure(false);
  const nzbsFetched = nzbRequests.mock.calls.length;
  assert.equal((await download(2)).error, "Tidarr is not set up");
  assert.equal(nzbRequests.mock.calls.length, nzbsFetched);
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
  test(`Usenet continues past ${albumGrab ? "track-only album-grab" : "denied"} results`, async () => {
    vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => [
      musicIndexer,
    ]);
    const artist = albumGrab ? "The Bend" : "The Band";
    const jobId = createTrackedJob(
      downloadTracker,
      { artistName: artist, trackName: "First", albumName: "Album", durationMs: 180000 },
      "usenet-exclusions",
    );
    assert.ok(jobId != null);
    if (!albumGrab) {
      for (const id of ["first-1", "first-2"])
        downloadTracker.recordDeniedSource(jobId, "usenet", id);
    }
    const originalDenials = structuredClone(trackedJob(downloadTracker, jobId).deniedRemoteSources);
    const original = prowlarrClient.search;
    let searches = 0;
    prowlarrClient.search = async () => {
      const first = ++searches === 1;
      return [1, 2].map((index) =>
        releaseFixture({
          guid: `${first ? "first" : "allowed"}-${index}`,
          title: `${artist} - ${first ? "First" : "Album"} FLAC`,
          protocol: "usenet",
          downloadUrl: `https://release.invalid/${first}/${index}`,
          indexerId: index,
          size: 100000000,
        }),
      );
    };
    try {
      const result = await searchUntilDone({ phase: "search", source: "usenet", jobId, albumGrab });
      assert.equal(result.phase, "download");
      assert.ok(result.candidates);
      assert.deepEqual(
        result.candidates.map((entry) => entry.raw.guid),
        ["allowed-1", "allowed-2"],
      );
      // A release title cannot prove the tracklist; the download is judged later.
      assert.ok(
        result.candidates.every(
          (entry) => entry.releaseVerified === (albumGrab ? false : undefined),
        ),
      );
      assert.deepEqual(trackedJob(downloadTracker, jobId).deniedRemoteSources, originalDenials);
    } finally {
      prowlarrClient.search = original;
    }
  });
}

test("a Usenet track search tries the requested album before a single of the track within a quality tier", async () => {
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => []);
  for (const [name, albumFormat, expected] of [
    ["Order", "FLAC", ["album", "single"]],
    ["Quality", "MP3", ["single", "album"]],
  ] as const) {
    const releases = [
      ["single", `${name} Band - A Song (2020) FLAC`],
      ["album", `${name} Band - Zebra Album ${albumFormat}`],
    ].map(([guid, title], index) =>
      releaseFixture({
        guid,
        title,
        protocol: "usenet",
        downloadUrl: `https://nzb.invalid/${name}/${guid}`,
        indexerId: index + 1,
        size: 100 * 1024 * 1024,
        categories: [3010],
      }),
    );
    const search = vi.spyOn(prowlarrClient, "search").mockImplementation(async () => releases);
    const jobId = createTrackedJob(
      downloadTracker,
      {
        artistName: `${name} Band`,
        trackName: "A Song",
        albumName: "Zebra Album",
        releaseYear: "2020",
        durationMs: 180000,
      },
      "usenet-order",
    );
    const result = await searchUntilDone({ phase: "search", source: "usenet", jobId });
    assert.ok(result.candidates);
    assert.deepEqual(
      result.candidates.map((entry) => entry.raw.guid),
      expected,
    );
    search.mockRestore();
  }
});

test("a Usenet search runs one Prowlarr query per pipeline step", async () => {
  for (const [name, results, error] of [
    ["Step", async () => [], "No suitable Usenet search results"],
    [
      "Down",
      async () => {
        throw new Error("indexer down");
      },
      "Prowlarr search failed: indexer down",
    ],
  ] as const) {
    const search = vi.spyOn(prowlarrClient, "search").mockImplementation(results);
    const jobId = createTrackedJob(
      downloadTracker,
      {
        artistName: `${name} Artist`,
        trackName: `${name} Song`,
        albumName: `${name} Album`,
        durationMs: 180000,
      },
      "usenet-steps",
    );
    let payload: UsenetResult = { phase: "search", source: "usenet", jobId };
    let steps = 0;
    while (payload?.phase === "search" && steps < 20) {
      const before = search.mock.calls.length;
      payload = await runPipeline(payload);
      assert.ok(search.mock.calls.length - before <= 1);
      steps += 1;
    }
    assert.equal(payload.error, error);
    assert.equal(steps, search.mock.calls.length);
    search.mockRestore();
  }
});

test("a Usenet compilation grab searches as VA and by its title, never by a track artist", async (t) => {
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => [
    musicIndexer,
  ]);
  const search = vi.spyOn(prowlarrClient, "search").mockImplementation(async () => []);
  const albumName =
    "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack";
  const ids = [
    ["Blue Swede", "Hooked on a Feeling"],
    ["Raspberries", "Go All the Way"],
  ].map(([artistName, trackName], index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName,
        trackName,
        trackNumber: index + 1,
        durationMs: 180000,
        albumName,
        albumMbid: "usenet-compilation",
        requestGroupId: "usenet-compilation",
      },
      "library",
    ),
  );
  const credits = [
    ["Blue Swede", "Hooked on a Feeling"],
    ["Raspberries", "Go All the Way"],
  ];
  await serveGroups(t, [
    brainzmashGroup({
      id: "usenet-compilation",
      title: albumName,
      artist: "Various Artists",
      artistId: "89ad4ac3-39f7-470e-963a-56509c546377",
      trackArtists: credits.map(([name]) => ({ id: `${name}-artist`, name })),
      releases: [
        {
          id: "usenet-compilation-release",
          tracks: credits.map(([artistName, title]) => ({
            title,
            artistId: `${artistName}-artist`,
            durationMs: 180000,
          })),
        },
      ],
    }),
  ]);
  await searchUntilDone({
    phase: "search",
    source: "usenet",
    jobId: ids[0],
    albumGrab: true,
    releaseMbid: "usenet-compilation-release",
  });
  assert.deepEqual(
    search.mock.calls.map((call) => call[0]),
    ["VA Guardians of the Galaxy Awesome Mix Vol 1", "Guardians of the Galaxy Awesome Mix Vol 1"],
  );
});

function admitted(titles: string[], context: Parameters<typeof rankUsenetReleases>[1]) {
  const releases = titles.map((title, index) => ({
    title,
    guid: `guid-${index}`,
    downloadUrl: `https://nzb.invalid/${index}`,
    protocol: "usenet",
    size: 300 * 1024 * 1024,
    categories: [3010],
  }));
  return rankUsenetReleases(releases, context)
    .filter((entry) => entry.releaseAdmissible)
    .map((entry) => [entry.raw.release.title, entry.resolvedAlbumName ? "album" : "track"]);
}

test("Usenet release titles match by their words, not by overall similarity", () => {
  const lemonade = admitted(
    [
      "Beyoncé feat. Kendrick Lamar - Lemonade (2016) MP3",
      "Beyonce - LEMONADE (2016)-NoGroup",
      "Lemonade Mouth - Original Soundtrack (2011)",
    ],
    { artistName: "Beyoncé", albumName: "Lemonade", trackName: "Formation" },
  );
  assert.deepEqual(lemonade.map(([title]) => title).sort(), [
    "Beyonce - LEMONADE (2016)-NoGroup",
    "Beyoncé feat. Kendrick Lamar - Lemonade (2016) MP3",
  ]);

  const soundtrack = admitted(
    [
      "VA-Guardians Of The Galaxy Awesome Mix Vol.1-OST-CD-FLAC-2014-CHS",
      "Guardians Of The Galaxy Awesome Mix Vol. 1-OST-2014-iTS",
      "Blue Swede - Hooked on a Feeling (1974)",
    ],
    {
      artistName: "Blue Swede",
      compilation: true,
      trackName: "Hooked on a Feeling",
      albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack",
    },
  );
  assert.deepEqual(
    soundtrack.map(([, kind]) => kind),
    ["album", "album"],
  );

  const selfTitled = admitted(
    ["Portishead - Discography 1994-2008 FLAC", "Portishead - Portishead (1997) FLAC"],
    { artistName: "Portishead", albumName: "Portishead", trackName: "Humming" },
  );
  assert.deepEqual(
    selfTitled.map(([title]) => title),
    ["Portishead - Portishead (1997) FLAC"],
  );

  const otherAlbumByName = admitted(
    [
      "A New Found Glory-From The Screen To Your Stereo-16BIT-WEB-FLAC-2000-VEXED",
      "New Found Glory-New Found Glory-CD-FLAC-2000-FATHEAD",
    ],
    {
      artistName: "New Found Glory",
      artistAliases: ["A New Found Glory"],
      albumName: "New Found Glory",
      trackName: "Better Off Dead",
    },
  );
  assert.deepEqual(
    otherAlbumByName.map(([title]) => title),
    ["New Found Glory-New Found Glory-CD-FLAC-2000-FATHEAD"],
  );

  const namedInAlbum = admitted(["Queen II (1974) FLAC"], {
    artistName: "Queen",
    albumName: "Queen II",
    trackName: "White Queen",
  });
  assert.equal(namedInAlbum.length, 1);

  const bookends = admitted(
    ["Simon and Garfunkel - Bookends (1968) FLAC", "Simon & Garfunkel - Bookends (1968) MP3"],
    { artistName: "Simon & Garfunkel", albumName: "Bookends", trackName: "America" },
  );
  assert.equal(bookends.length, 2);
});

test("a Usenet single in another version is not offered for the original track", () => {
  const releases = admitted(
    [
      "Daft Punk Pharrell Williams Nile Rodgers-Get Lucky Daft Punk Remix -24BIT-WEBFLAC-2013-STASIAUDIO",
      "Daft Punk Pharrell Williams Nile Rodgers-Get Lucky Radio Edit -24BIT-WEBFLAC-2013-STASIAUDIO",
      "Daft Punk - Get Lucky (feat. Pharrell Williams) [2013] FLAC",
      "Daft Punk - Random Access Memories (2013) FLAC",
      "Daft Punk - Random Access Memories (Acoustic) (2013) FLAC",
      "Daft Punk - Random Access Memories Instrumentals (2013) FLAC",
      "Daft Punk - Random Access Memories (Remixes) WEB FLAC",
    ],
    { artistName: "Daft Punk", albumName: "Random Access Memories", trackName: "Get Lucky" },
  );
  assert.deepEqual(releases.map(([title, kind]) => `${kind}: ${title}`).sort(), [
    "album: Daft Punk - Random Access Memories (2013) FLAC",
    "track: Daft Punk - Get Lucky (feat. Pharrell Williams) [2013] FLAC",
  ]);

  const titleTrack = admitted(
    [
      "Michael Jackson - Thriller (Radio Edit) [Single] FLAC",
      "Michael Jackson - Thriller (1982) FLAC",
    ],
    { artistName: "Michael Jackson", albumName: "Thriller", trackName: "Thriller" },
  );
  assert.deepEqual(
    titleTrack.map(([title]) => title),
    ["Michael Jackson - Thriller (1982) FLAC"],
  );

  const oceanAvenue = [
    "Yellowcard - Ocean Avenue Acoustic (2013) FLAC",
    "Yellowcard - Ocean Avenue (2003) FLAC",
  ];
  const yellowcard = { artistName: "Yellowcard", trackName: "Way Away" };
  assert.deepEqual(admitted(oceanAvenue, { ...yellowcard, albumName: "Ocean Avenue" }), [
    ["Yellowcard - Ocean Avenue (2003) FLAC", "album"],
  ]);
  assert.deepEqual(admitted(oceanAvenue, { ...yellowcard, albumName: "Ocean Avenue Acoustic" }), [
    ["Yellowcard - Ocean Avenue Acoustic (2013) FLAC", "album"],
  ]);

  const alive = ["KISS - Alive! (Live) (1975) FLAC"];
  const kiss = { artistName: "KISS", albumName: "Alive!", trackName: "Deuce" };
  assert.deepEqual(admitted(alive, { ...kiss, secondaryTypes: ["Live"] }), [[alive[0], "album"]]);
  assert.deepEqual(admitted(alive, { ...kiss, secondaryTypes: [] }), []);

  assert.deepEqual(
    admitted(["Faith No More - Angel Dust (Deluxe Edition) FLAC"], {
      artistName: "Faith No More",
      albumName: "Angel Dust (Deluxe Edition)",
      trackName: "Easy (Live in Munich)",
    }),
    [["Faith No More - Angel Dust (Deluxe Edition) FLAC", "album"]],
  );

  const scene = admitted(
    [
      "Daft_Punk-Random_Access_Memories-WEB-2013-GRP",
      "Daft_Punk-Random_Access_Memories_Instrumentals-WEB-2013-GRP",
      "Daft_Punk-Random_Access_Memories_Remixes-WEB-2013-GRP",
      "Daft_Punk-Random_Access_Memories_(The_Remixes)-WEB-2013-GRP",
      "Daft_Punk-Random_Access_Memories_Live-WEB-2013-GRP",
      "Daft.Punk-Random.Access.Memories.Live.2013.FLAC-GRP",
    ],
    { artistName: "Daft Punk", albumName: "Random Access Memories", trackName: "Get Lucky" },
  );
  assert.deepEqual(scene, [["Daft_Punk-Random_Access_Memories-WEB-2013-GRP", "album"]]);
});

test("a Usenet release named for another version is not offered however its title notes it, for any track", () => {
  for (const trackName of ["First Song", "Album"]) {
    const context = { artistName: "The Band", albumName: "Album", trackName };
    assert.deepEqual(
      admitted(
        OTHER_VERSION_LABELS.map(([title]) => title),
        context,
      ),
      [],
      trackName,
    );
    assert.deepEqual(
      admitted(SAME_VERSION_LABELS, context)
        .map(([title]) => title)
        .toSorted(),
      SAME_VERSION_LABELS.toSorted(),
      trackName,
    );
  }
  assert.deepEqual(
    admitted(
      [
        "Live - Throwing Copper (1994) FLAC",
        "Live - Throwing Copper (Live at Woodstock 1999) FLAC",
      ],
      { artistName: "Lïve", albumName: "Throwing Copper", trackName: "Selling the Drama" },
    ),
    [["Live - Throwing Copper (1994) FLAC", "album"]],
  );
  assert.deepEqual(
    admitted(["Wings - Live and Let Die (1973) FLAC"], {
      artistName: "Wings",
      albumName: "Red Rose Speedway",
      trackName: "Live and Let Die",
    }),
    [["Wings - Live and Let Die (1973) FLAC", "track"]],
  );
  assert.deepEqual(
    admitted(
      ["The Band - Song (Live at Wembley) FLAC", "The Band - Album (Live at Wembley) FLAC"],
      { artistName: "The Band", albumName: "Album", trackName: "Song (Live at Wembley)" },
    ),
    [["The Band - Song (Live at Wembley) FLAC", "track"]],
  );

  const liveDisc = ["The Band - Album (Deluxe Edition) (Bonus Live Disc) FLAC"];
  const deluxe = { artistName: "The Band", albumName: "Album", trackName: "First Song" };
  const tracks = (...discs: string[][]) =>
    discs.flatMap((titles, disc) => titles.map((title) => ({ title, discNumber: disc + 1 })));
  assert.deepEqual(
    admitted(liveDisc, {
      ...deluxe,
      releaseTracks: tracks(
        ["First Song", "Second Song", "Third Song"],
        ["First Song (Live at Wembley)"],
      ),
    }),
    [[liveDisc[0], "album"]],
  );
  assert.deepEqual(
    admitted(liveDisc, { ...deluxe, releaseTracks: tracks(["First Song", "Second Song"]) }),
    [],
  );
  assert.deepEqual(
    admitted(["The Band - Album (Live at Wembley) FLAC", "The Band - Album [Live] FLAC"], {
      ...deluxe,
      releaseTracks: tracks([
        "First Song",
        "Second Song",
        "Third Song",
        "First Song (Live at the Troubadour)",
      ]),
    }),
    [],
  );
});

test("a compilation track takes a single by its own artist from Usenet", () => {
  const context = {
    artistName: "Various Artists",
    artistAliases: ["Blue Swede"],
    trackName: "Hooked on a Feeling",
    albumName: "Guardians of the Galaxy: Awesome Mix, Vol. 1",
  };
  assert.deepEqual(
    admitted(
      ["Blue Swede - Hooked on a Feeling (1974)", "Redbone - Come and Get Your Love (1974)"],
      context,
    ),
    [["Blue Swede - Hooked on a Feeling (1974)", "track"]],
  );
});

async function runUntilSettled(payload: UsenetPayload) {
  let result: UsenetResult = payload;
  while (["search", "download", "poll"].includes(result.phase)) result = await runPipeline(result);
  return result;
}

function trackReleases(artistName: string, downloadUrl: (indexerId: number) => string) {
  return [1, 2, 3, 4, 5].map((indexerId) =>
    releaseFixture({
      guid: `${artistName}-${indexerId}`,
      title: `${artistName} - Atomic MP3`,
      protocol: "usenet",
      downloadUrl: downloadUrl(indexerId),
      indexerId,
      indexer: `Indexer ${indexerId}`,
      size: 9 * 1024 * 1024,
      categories: [3010],
    }),
  );
}

test("an indexer that answers HTTP 429 gets no NZB request from any job until its Retry-After passes", async (t: import("vite-plus/test").TestContext) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2000-01-01T12:00:00Z") });
  const requests: (string | undefined)[] = [];
  const server = await createMockHttpServer((req, res) => {
    requests.push(req.url);
    if (req.url?.startsWith("/1/")) {
      res.writeHead(429, {
        ...(req.url?.includes("Three") ? {} : { "Retry-After": "600" }),
        "Content-Type": "text/xml",
      });
      res.end(
        '<error code="429" description="User configurable Indexer Grab Limit of 5 in last 24 hour(s) reached."/>',
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>Not an NZB</body></html>");
  });
  t.onTestFinished(() => server.close());
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => []);
  vi.spyOn(prowlarrClient, "search").mockImplementation(async (query: string) => {
    const artistName = query.split(" ").slice(0, 2).join(" ");
    return trackReleases(
      artistName,
      (indexerId) => `${server.url}/${indexerId}/${artistName.replace(" ", "-")}`,
    ).filter(
      (release) =>
        release.indexerId !== null && release.indexerId <= (artistName === "Limited Two" ? 1 : 2),
    );
  });
  const run = (artistName: string) =>
    runUntilSettled({
      phase: "search",
      source: "usenet",
      jobId: createTrackedJob(
        downloadTracker,
        { artistName, trackName: "Atomic", durationMs: 230000 },
        "usenet-rate-limit",
      ),
    });

  const first = await run("Limited One");
  const second = await run("Limited Two");
  assert.deepEqual(requests, ["/1/Limited-One", "/2/Limited-One"]);
  assert.equal(first.error, "The indexer did not return an NZB file");
  assert.equal(
    second.error,
    "Indexer 1 has reached its NZB limit. Aurral will ask it again in 10 minutes.",
  );

  vi.advanceTimersByTime(601 * 1000);
  await run("Limited Three");
  assert.deepEqual(requests.slice(2), ["/1/Limited-Three", "/2/Limited-Three"]);

  vi.advanceTimersByTime(30 * 60 * 1000);
  await run("Limited Four");
  assert.deepEqual(requests.slice(4), ["/2/Limited-Four"]);
});

test("a track spends its two NZB grabs on indexers that answer, not on ones that are limited", async (t: import("vite-plus/test").TestContext) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2000-01-02T12:00:00Z") });
  const requests: (string | undefined)[] = [];
  const server = await createMockHttpServer((req, res) => {
    requests.push(req.url);
    const retryAfter = new Map([
      ["1", "600"],
      ["2", "0"],
    ]).get((req.url || "/").split("/")[1]);
    if (retryAfter) {
      res.writeHead(429, { "Retry-After": retryAfter, "Content-Type": "text/xml" });
      res.end('<error code="429" description="Grab limit reached"/>');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/x-nzb" });
    res.end('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>');
  });
  t.onTestFinished(() => server.close());
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => []);
  vi.spyOn(prowlarrClient, "search").mockImplementation(async (query: string) => {
    const artistName = query.split(" ").slice(0, 2).join(" ");
    return trackReleases(
      artistName,
      (indexerId) => `${server.url}/${indexerId}/${artistName.replace(" ", "-")}`,
    );
  });
  const appended = vi
    .spyOn(nzbgetClient, "appendNzb")
    .mockImplementation(async () => ({ nzbId: requests.length, nzbName: "Atomic" }));
  vi.spyOn(nzbgetClient, "getHistoryItem").mockImplementation(async (nzbId) => {
    assert.equal(typeof nzbId, "number");
    return { NZBID: Number(nzbId), Status: "FAILURE/HEALTH" };
  });
  vi.spyOn(nzbgetClient, "deleteQueueItem").mockImplementation(async () => true);
  vi.spyOn(nzbgetClient, "deleteHistoryItem").mockImplementation(async () => true);
  const run = (artistName: string) =>
    runUntilSettled({
      phase: "search",
      source: "usenet",
      jobId: createTrackedJob(
        downloadTracker,
        { artistName, trackName: "Atomic", durationMs: 230000 },
        "usenet-grab-slots",
      ),
    });

  const first = await run("Grab One");
  assert.deepEqual(requests, ["/1/Grab-One", "/2/Grab-One", "/3/Grab-One", "/4/Grab-One"]);
  assert.equal(first.error, "Usenet download failed: FAILURE/HEALTH");

  await run("Grab Two");
  assert.deepEqual(requests.slice(4), ["/2/Grab-Two", "/3/Grab-Two", "/4/Grab-Two"]);
  assert.equal(appended.mock.calls.length, 4);
});

test("a track spends a grab on a broken NZB but not on a Newznab error", async (t: import("vite-plus/test").TestContext) => {
  const requests: (string | undefined)[] = [];
  const server = await createMockHttpServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "Content-Type": "application/x-nzb" });
    res.end(
      ["1", "2"].includes((req.url || "/").split("/")[1])
        ? '<?xml version="1.0"?><error code="300" description="No such item"/>'
        : '<?xml version="1.0"?><nz',
    );
  });
  t.onTestFinished(() => server.close());
  vi.spyOn(prowlarrClient, "getEnabledUsenetIndexers").mockImplementation(async () => []);
  vi.spyOn(prowlarrClient, "search").mockImplementation(async () =>
    trackReleases("Broken Grab", (indexerId) => `${server.url}/${indexerId}/broken`),
  );
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Broken Grab", trackName: "Atomic", durationMs: 230000 },
    "usenet-broken-nzb",
  );

  const result = await runUntilSettled({ phase: "search", source: "usenet", jobId });

  assert.deepEqual(requests, ["/1/broken", "/2/broken", "/3/broken", "/4/broken"]);
  assert.equal(result.error, "The indexer did not return an NZB file");
});
