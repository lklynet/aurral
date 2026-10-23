import { candidateFile, createTrackedJob, trackedJob } from "./fixtures.ts";
import { test, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker, DownloadTracker },
  { getDownloadClient },
  { processPipelinePayload },
  { processSystemTask },
  { downloadWorker },
] = await setupIsolatedBackend(
  "slskd-search-steps",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/download/downloadClientSettings.ts"),
  () => import("../../backend/services/downloadPipeline.ts"),
  () => import("../../backend/services/systemTaskWorker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
);

afterAll(() => cleanupIsolatedState(state));

dbOps.updateSettings({
  ...dbOps.getSettings(),
  integrations: {
    slskd: { enabled: true, url: "http://127.0.0.1:9" },
  },
});
const client = getDownloadClient("slskd");

function folderResponses(artist: string, album: string, titles: string[]) {
  return ["one", "two", "three"].map((username) => ({
    username,
    hasFreeUploadSlot: true,
    uploadSpeed: 500000,
    files: titles.map((title, index) => ({
      filename: `Music\\${artist}\\${album}\\0${index + 1} - ${title}.flac`,
      size: 30000000,
      length: 200,
    })),
  }));
}

type SlskdSearch = Awaited<ReturnType<typeof client.getSearch>>;
type PipelinePayload = Parameters<typeof processPipelinePayload>[0];

function mockSearch(t: import("vite-plus/test").TestContext, searches: SlskdSearch[]) {
  let searchCount = 0;
  const created = vi.spyOn(client, "createSearch").mockImplementation(async (query, options) => {
    const id = `search-${++searchCount}`;
    options?.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  const polled = vi.spyOn(client, "getSearch").mockImplementation(async () => {
    const next = searches.shift();
    assert.ok(next != null, "Unexpected extra search poll");
    return next;
  });
  vi.spyOn(client, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(client, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  return { created, polled };
}

async function runToDownload(payload: PipelinePayload) {
  let next: Awaited<ReturnType<typeof processPipelinePayload>> = payload;
  const phases: (string | undefined)[] = [];
  while (next?.phase === "search") {
    next = await processPipelinePayload(next);
    phases.push(next?.phase);
  }
  return { next, phases };
}

test("a Soulseek search advances one poll per pipeline step", async (t) => {
  const responses = folderResponses("Step Band", "Step Album", ["Song"]);
  const { created, polled } = mockSearch(t, [
    { state: "InProgress", responses: [] },
    { state: "Completed, Succeeded", fileCount: 3, responses },
  ]);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Step Band", trackName: "Song", durationMs: 200000 },
    "library",
  );

  const first = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.ok(first != null);
  assert.equal(first.phase, "search");
  assert.equal(first.activeSearch!.id, "search-1");
  assert.ok(first.delaySeconds != null);
  assert.ok(first.delaySeconds >= 1);
  assert.equal(polled.mock.calls.length, 0);

  const second = await processPipelinePayload(first);
  assert.ok(second != null);
  assert.equal(second.phase, "search");
  assert.equal(polled.mock.calls.length, 1);

  const third = await processPipelinePayload(second);
  assert.ok(third != null);
  assert.equal(third.phase, "download");
  assert.equal(third.activeSearch, null);
  assert.equal(created.mock.calls.length, 1);
  assert.ok(third.candidates != null);
  assert.ok(third.candidates.length > 0);
});

test("a Soulseek search that slskd keeps queued past five minutes waits for it to run", async (t) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  const responses = folderResponses("Queued Band", "Queued Album", ["Song"]);
  let running = false;
  const { created } = mockSearch(t, []);
  vi.spyOn(client, "getSearch").mockImplementation(async () =>
    running
      ? { state: "Completed, Succeeded", fileCount: 3, responses }
      : { state: "Queued", responses: [] },
  );
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Queued Band", trackName: "Song", durationMs: 200000 },
    "library",
  );

  const started = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.ok(started != null);
  const queuedAt = Date.now();
  vi.advanceTimersByTime(30000);
  let next = started;
  assert.ok(next != null);
  while (Date.now() - queuedAt < 10 * 60 * 1000) {
    assert.ok(next.delaySeconds != null);
    vi.advanceTimersByTime(next.delaySeconds * 1000);
    const advanced = await processPipelinePayload(next);
    assert.ok(advanced != null);
    next = advanced;
    assert.equal(next.phase, "search");
    assert.equal(next.activeSearch?.id, started.activeSearch!.id);
  }
  assert.equal(created.mock.calls.length, 1);
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "failed");

  running = true;
  assert.ok(next.delaySeconds != null);
  vi.advanceTimersByTime(next.delaySeconds * 1000);
  const ran = await processPipelinePayload(next);
  assert.ok(ran != null);
  assert.equal(ran.phase, "download");
  assert.equal(created.mock.calls.length, 1);
  assert.ok(ran.candidates != null);
  assert.match(candidateFile(ran.candidates[0]), /Queued Album\\01 - Song\.flac$/);
});

test("a Soulseek search that starts running just before its monitor is rebuilt keeps its results", async (t) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  const responses = folderResponses("Late Band", "Late Album", ["Song"]);
  const createdAt = Date.now();
  const { created } = mockSearch(t, []);
  vi.spyOn(client, "getSearch").mockImplementation(async (id, options) => {
    assert.ok(options != null);
    assert.ok(options.timeout != null);
    if (options.timeout < 50) throw new Error("This operation was aborted");
    const elapsed = Date.now() - createdAt;
    if (elapsed < 9 * 60 * 1000 + 50000) return { state: "Queued", responses: [] };
    if (elapsed < 10 * 60 * 1000 + 30000)
      return { state: "InProgress", fileCount: 3, responses: [] };
    return { state: "Completed, Succeeded", fileCount: 3, responses };
  });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Late Band", trackName: "Song", durationMs: 200000 },
    "library",
  );

  let next = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.ok(next != null);
  while (next?.phase === "search" && Date.now() - createdAt < 15 * 60 * 1000) {
    assert.ok(next.delaySeconds != null);
    vi.advanceTimersByTime(next.delaySeconds * 1000);
    next = await processPipelinePayload(next);
  }
  assert.ok(next != null);
  assert.equal(next.phase, "download");
  assert.equal(created.mock.calls.length, 1);
  assert.ok(next != null);
  assert.ok(next.candidates != null);
  assert.match(candidateFile(next.candidates[0]), /Late Album\\01 - Song\.flac$/);
});

test("tracks from one album reuse the album search", async (t) => {
  const responses = folderResponses("Shared Band", "Shared Album", ["First", "Second"]);
  const { created } = mockSearch(t, [{ state: "Completed, Succeeded", fileCount: 6, responses }]);
  const [first, second] = ["First", "Second"].map((trackName, index) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "Shared Band",
        albumName: "Shared Album",
        trackName,
        trackNumber: index + 1,
        durationMs: 200000,
        albumTrackTitles: ["First", "Second"],
      },
      "library",
    ),
  );

  const firstResult = await runToDownload({ phase: "search", source: "slskd", jobId: first });
  assert.equal(firstResult.next?.phase, "download");
  const secondResult = await runToDownload({ phase: "search", source: "slskd", jobId: second });
  assert.ok(secondResult.next != null);
  assert.equal(secondResult.next.phase, "download");
  assert.equal(created.mock.calls.length, 1);
  assert.ok(secondResult.next.candidates != null);
  assert.match(candidateFile(secondResult.next.candidates[0]), /Second\.flac$/);
});

test("a failed Soulseek poll moves on to the next query", async () => {
  let searchCount = 0;
  const created = vi.spyOn(client, "createSearch").mockImplementation(async (query, options) => {
    const id = `failing-${++searchCount}`;
    options?.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  vi.spyOn(client, "getSearch").mockImplementation(async () => {
    throw new Error("slskd restarted");
  });
  vi.spyOn(client, "deleteSearch").mockImplementation(async () => true);
  vi.spyOn(client, "isCleanupAfterRunsEnabled").mockImplementation(() => false);
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Failing Band",
      trackName: "Lost Song",
      albumName: "Lost Album",
      durationMs: 200000,
    },
    "library",
  );

  const first = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.ok(first != null);
  const second = await processPipelinePayload(first);
  assert.ok(second != null);
  assert.equal(second.phase, "search");
  assert.equal(second.searchQueryIndex, 1);
  assert.notEqual(second.activeSearch!.query, first.activeSearch!.query);
  assert.equal(created.mock.calls.length, 2);
});

async function startSoulseek(t: import("vite-plus/test").TestContext) {
  const soulseek: {
    loggedIn: boolean;
    searches: { id: string }[];
    enqueues: string[];
    deleted: string[];
    transferState: string;
    holdDelete: ((reply: (status: number) => void) => void) | null;
  } = {
    loggedIn: false,
    searches: [],
    enqueues: [],
    deleted: [],
    transferState: "InProgress",
    holdDelete: null,
  };
  const loggedOut = (action: string) =>
    `The server connection must be connected and logged in to ${action} (currently: Connected, LoggingIn)`;
  const server = await createMockHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const send = (status: number, data: string | object) => {
        res.writeHead(status, {
          "content-type": typeof data === "string" ? "text/plain" : "application/json",
        });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.method === "GET" && req.url === "/api/v0/application") {
        return send(200, {
          server: soulseek.loggedIn
            ? { state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true }
            : { state: "Connected, LoggingIn", isConnected: true, isLoggedIn: false },
        });
      }
      if (req.method === "GET" && req.url === "/api/v0/options") {
        return send(200, { directories: { downloads: "/downloads" } });
      }
      if (req.method === "POST" && req.url === "/api/v0/searches") {
        if (!soulseek.loggedIn) return send(409, loggedOut("perform a search"));
        soulseek.searches.push(JSON.parse(body));
        return send(200, { id: JSON.parse(body).id });
      }
      assert.ok(req.url != null);
      if (req.method === "POST" && req.url.startsWith("/api/v0/transfers/downloads/")) {
        if (!soulseek.loggedIn) return send(500, loggedOut("fetch user endpoint"));
        assert.ok(req.url != null);
        soulseek.enqueues.push(decodeURIComponent(req.url.split("/").pop()!));
        return send(201, { enqueued: [{ id: "transfer-1" }], failed: [] });
      }
      assert.ok(req.url != null);
      if (req.method === "GET" && req.url.startsWith("/api/v0/transfers/downloads/")) {
        assert.ok(req.url != null);
        return send(200, { id: req.url.split("/").pop(), state: soulseek.transferState });
      }
      if (req.method === "DELETE" && soulseek.holdDelete) {
        const hold = soulseek.holdDelete;
        soulseek.holdDelete = null;
        return hold((status) => send(status, ""));
      }
      if (req.method === "DELETE") assert.ok(req.url != null);
      if (req.method === "DELETE") soulseek.deleted.push(req.url.split("?")[0]);
      assert.ok(req.url != null);
      if (req.method === "GET" && req.url.startsWith("/api/v0/events")) return send(200, []);
      return send(404, "");
    });
  });
  const originalSettings = dbOps.getSettings();
  resetDatabase(db);
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: server.url },
      deemix: { enabled: true, url: "http://127.0.0.1:9" },
    },
  });
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  t.onTestFinished(async () => {
    dbOps.updateSettings(originalSettings);
    await server.close();
  });
  return soulseek;
}

function soulseekCandidate(user: string) {
  return {
    raw: { user, file: "Music\\Waiting Band\\Waiting Album\\01 - Song.flac", size: 30000000 },
  };
}

function transferHistoryCount() {
  return db
    .prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM slskd_transfer_history")
    .get()!.count;
}

test("a download waits while Soulseek logs in instead of skipping or blaming peers", async (t) => {
  const soulseek = await startSoulseek(t);
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Waiting Band", trackName: "Song" },
    "library",
  );
  const candidates = ["first-peer", "second-peer", "third-peer"].map(soulseekCandidate);

  const held = await processPipelinePayload({
    phase: "download",
    source: "slskd",
    jobId,
    candidates,
    candidateIndex: 0,
  });
  assert.ok(held != null);
  assert.equal(held.phase, "download");
  assert.equal(held.candidateIndex, 0);
  assert.ok(held.delaySeconds != null);
  assert.ok(held.delaySeconds > 0);
  assert.equal(transferHistoryCount(), 0);

  assert.ok(held.delaySeconds != null);
  vi.advanceTimersByTime(held.delaySeconds * 1000);
  const stillHeld = await processPipelinePayload(held);
  assert.ok(stillHeld != null);
  assert.equal(stillHeld.candidateIndex, 0);
  assert.equal(transferHistoryCount(), 0);
  assert.notEqual(trackedJob(downloadTracker, jobId).status, "failed");

  soulseek.loggedIn = true;
  assert.ok(stillHeld.delaySeconds != null);
  vi.advanceTimersByTime(stillHeld.delaySeconds * 1000);
  const resumed = await processPipelinePayload(stillHeld);
  assert.ok(resumed != null);
  assert.equal(resumed.phase, "poll");
  assert.deepEqual(soulseek.enqueues, ["first-peer"]);
});

test("a search refused while Soulseek logs in waits and resumes after login", async (t) => {
  const soulseek = await startSoulseek(t);
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Waiting Band",
      trackName: "Song",
      albumName: "Waiting Album",
      durationMs: 200000,
    },
    "library",
  );

  const held = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.ok(held != null);
  assert.equal(held.phase, "search");
  assert.equal(held.source, "slskd");
  assert.ok(held.delaySeconds != null);
  assert.ok(held.delaySeconds > 0);
  assert.equal(trackedJob(downloadTracker, jobId).status, "downloading");

  assert.ok(held.delaySeconds != null);
  vi.advanceTimersByTime(held.delaySeconds * 1000);
  const stillHeld = await processPipelinePayload(held);
  assert.ok(stillHeld != null);
  assert.equal(stillHeld.phase, "search");
  assert.equal(soulseek.searches.length, 0);

  soulseek.loggedIn = true;
  assert.ok(stillHeld.delaySeconds != null);
  vi.advanceTimersByTime(stillHeld.delaySeconds * 1000);
  const resumed = await processPipelinePayload(stillHeld);
  assert.ok(resumed != null);
  assert.equal(resumed.phase, "search");
  assert.equal(soulseek.searches.length, 1);
  assert.equal(resumed.activeSearch!.query, held.searchQueries![0]);
});

test("a transfer that fails while Soulseek logs in is retried from the same peer after login", async (t) => {
  const soulseek = await startSoulseek(t);
  soulseek.loggedIn = true;
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Waiting Band", trackName: "Song" },
    "library",
  );
  const polling = await processPipelinePayload({
    phase: "download",
    source: "slskd",
    jobId,
    candidateIndex: 0,
    candidateRetryCounts: { 0: 0 },
    candidates: ["first-peer", "second-peer"].map(soulseekCandidate),
  });
  assert.ok(polling != null);
  assert.equal(polling.phase, "poll");

  soulseek.loggedIn = false;
  soulseek.transferState = "Completed, Errored";
  const held = await processPipelinePayload(polling);
  assert.ok(held != null);
  assert.equal(held.phase, "download");
  assert.equal(held.candidateIndex, 0);
  assert.deepEqual(held.candidateRetryCounts, { 0: 0 });
  assert.equal(transferHistoryCount(), 0);
  assert.deepEqual(soulseek.deleted, ["/api/v0/transfers/downloads/first-peer/transfer-1"]);

  soulseek.loggedIn = true;
  assert.ok(held.delaySeconds != null);
  vi.advanceTimersByTime(held.delaySeconds * 1000);
  const resumed = await processPipelinePayload(held);
  assert.ok(resumed != null);
  assert.equal(resumed.phase, "poll");
  assert.equal(resumed.candidateIndex, 0);
  assert.deepEqual(soulseek.enqueues, ["first-peer", "first-peer"]);
  assert.equal(transferHistoryCount(), 0);
});

async function startUpgradeSearch(artistName: string) {
  const doneId = createTrackedJob(
    downloadTracker,
    { artistName, trackName: "Song", albumName: "Restart Album", durationMs: 200000 },
    "library",
  );
  assert.ok(doneId != null);
  downloadTracker.setDone(doneId, `/library/${artistName}/Restart Album/01 - Song.mp3`);
  const upgradeId = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, doneId));
  assert.ok(upgradeId != null);
  const searching = await processPipelinePayload({
    phase: "search",
    source: "slskd",
    jobId: upgradeId,
    upgradeForJobId: doneId,
  });
  return { upgradeId, searching };
}

function trackedSlskdSearchIds() {
  return db
    .prepare<
      unknown[],
      { work_id: import("../../backend/db/rows.ts").WeeklyFlowDownloadProviderWorkRow["work_id"] }
    >(
      "SELECT work_id FROM weekly_flow_download_provider_work WHERE provider = 'slskd-search' ORDER BY work_id",
    )
    .all()
    .map((row) => row.work_id);
}

test("a restart that drops an upgrade deletes the upgrade's running search from slskd", async (t) => {
  const soulseek = await startSoulseek(t);
  soulseek.loggedIn = true;
  const { upgradeId, searching } = await startUpgradeSearch("Restart Band");
  assert.ok(searching != null);
  const searchId = searching.activeSearch!.id;
  const trackedSearches = () =>
    db
      .prepare<unknown[], { count: number }>(
        "SELECT COUNT(*) AS count FROM weekly_flow_download_provider_work WHERE work_id = ?",
      )
      .get(searchId)!.count;
  assert.deepEqual(
    soulseek.searches.map((search) => search.id),
    [searchId],
  );
  assert.equal(trackedSearches(), 1);

  downloadTracker.resetDownloadingToPending();
  const restarted = new DownloadTracker();
  assert.equal(restarted.getJob(upgradeId), null);

  assert.equal(await processPipelinePayload(searching), null);
  assert.deepEqual(soulseek.deleted, [`/api/v0/searches/${searchId}`]);
  assert.equal(trackedSearches(), 0);
});

test("after a restart Aurral resumes downloads first, then deletes only its slskd searches whose jobs no longer exist", async (t) => {
  const soulseek = await startSoulseek(t);
  soulseek.loggedIn = true;
  const { searching: dropped } = await startUpgradeSearch("Orphan Band");
  vi.advanceTimersByTime(5000);
  const liveId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Live Band",
      trackName: "Live Song",
      albumName: "Live Album",
      durationMs: 200000,
    },
    "library",
  );
  const live = await processPipelinePayload({ phase: "search", source: "slskd", jobId: liveId });
  assert.ok(live != null);
  assert.equal(soulseek.searches.length, 2);

  downloadTracker.resetDownloadingToPending();
  new DownloadTracker();
  const workerStarts = vi.spyOn(downloadWorker, "start").mockImplementation(async () => {});
  const heldDelete = new Promise<(status: number) => void>((resolve) => {
    soulseek.holdDelete = resolve;
  });
  const startup = processSystemTask({ kind: "weekly-flow-startup-check" });
  const respond = await Promise.race([
    heldDelete,
    startup.then(
      () => null,
      () => null,
    ),
  ]);
  assert.ok(respond, "slskd never received a delete for the dropped upgrade's search");
  assert.equal(
    workerStarts.mock.calls.length,
    1,
    "the download worker must start before Aurral waits on slskd",
  );
  respond(503);
  await assert.rejects(startup, { message: "Could not cancel slskd work" });
  assert.ok(dropped != null);
  assert.deepEqual(
    trackedSlskdSearchIds(),
    [dropped.activeSearch!.id, live.activeSearch!.id].sort(),
  );

  await processSystemTask({ kind: "weekly-flow-startup-check" });
  assert.ok(dropped != null);
  assert.deepEqual(soulseek.deleted, [`/api/v0/searches/${dropped.activeSearch!.id}`]);
  assert.deepEqual(trackedSlskdSearchIds(), [live.activeSearch!.id]);
});

for (const phase of ["search", "download"]) {
  test(`a ${phase} tries the next source when Soulseek stays logged out past the wait limit`, async (t) => {
    await startSoulseek(t);
    const jobId = createTrackedJob(
      downloadTracker,
      {
        artistName: "Waiting Band",
        trackName: "Song",
        albumName: "Waiting Album",
        durationMs: 200000,
      },
      "library",
    );
    const heldAt = Date.now();
    let next = await processPipelinePayload({
      phase,
      source: "slskd",
      jobId,
      candidates: [soulseekCandidate("first-peer")],
      candidateIndex: 0,
    });
    assert.ok(next != null);
    while (next?.source === "slskd" && Date.now() - heldAt < 2 * 60 * 60 * 1000) {
      assert.ok(next.delaySeconds != null);
      vi.advanceTimersByTime(next.delaySeconds * 1000);
      next = await processPipelinePayload(next);
    }
    assert.ok(next != null);
    assert.equal(next.source, "deemix");
    assert.ok(next != null);
    assert.equal(next.phase, "search");
    assert.ok(
      Date.now() - heldAt >= 30 * 60 * 1000,
      "the wait must outlast a 30-minute Soulseek ban",
    );
    assert.equal(transferHistoryCount(), 0);
  });
}
