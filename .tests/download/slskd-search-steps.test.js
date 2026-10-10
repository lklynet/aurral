import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, createMockHttpServer, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { downloadTracker }, { getDownloadClient }, { processPipelinePayload }] =
  await setupIsolatedBackend(
    "slskd-search-steps",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/download/downloadClientSettings.js",
    "backend/services/downloadPipeline.js",
  );

test.after(() => cleanupIsolatedState(state));

dbOps.updateSettings({ ...dbOps.getSettings(), integrations: {
  slskd: { enabled: true, url: "http://127.0.0.1:9" },
} });
const client = getDownloadClient("slskd");

function folderResponses(artist, album, titles) {
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

function mockSearch(t, searches) {
  let searchCount = 0;
  const created = t.mock.method(client, "createSearch", async (query, options) => {
    const id = `search-${++searchCount}`;
    options.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  const polled = t.mock.method(client, "getSearch", async () => searches.shift());
  t.mock.method(client, "deleteSearch", async () => true);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  return { created, polled };
}

async function runToDownload(payload) {
  let next = payload;
  const phases = [];
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
  const jobId = downloadTracker.addJob({ artistName: "Step Band", trackName: "Song", durationMs: 200000 }, "library");

  const first = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.equal(first.phase, "search");
  assert.equal(first.activeSearch.id, "search-1");
  assert.ok(first.delaySeconds >= 1);
  assert.equal(polled.mock.callCount(), 0);

  const second = await processPipelinePayload(first);
  assert.equal(second.phase, "search");
  assert.equal(polled.mock.callCount(), 1);

  const third = await processPipelinePayload(second);
  assert.equal(third.phase, "download");
  assert.equal(third.activeSearch, null);
  assert.equal(created.mock.callCount(), 1);
  assert.ok(third.candidates.length > 0);
});

test("tracks from one album reuse the album search", async (t) => {
  const responses = folderResponses("Shared Band", "Shared Album", ["First", "Second"]);
  const { created } = mockSearch(t, [{ state: "Completed, Succeeded", fileCount: 6, responses }]);
  const [first, second] = ["First", "Second"].map((trackName, index) => downloadTracker.addJob({
    artistName: "Shared Band", albumName: "Shared Album", trackName, trackNumber: index + 1,
    durationMs: 200000, albumTrackTitles: ["First", "Second"],
  }, "library"));

  const firstResult = await runToDownload({ phase: "search", source: "slskd", jobId: first });
  assert.equal(firstResult.next.phase, "download");
  const secondResult = await runToDownload({ phase: "search", source: "slskd", jobId: second });
  assert.equal(secondResult.next.phase, "download");
  assert.equal(created.mock.callCount(), 1);
  assert.match(secondResult.next.candidates[0].raw.file, /Second\.flac$/);
});

test("a failed Soulseek poll moves on to the next query", async (t) => {
  let searchCount = 0;
  const created = t.mock.method(client, "createSearch", async (query, options) => {
    const id = `failing-${++searchCount}`;
    options.onSearchCreated?.(id);
    return { id, searchText: query };
  });
  t.mock.method(client, "getSearch", async () => { throw new Error("slskd restarted"); });
  t.mock.method(client, "deleteSearch", async () => true);
  t.mock.method(client, "isCleanupAfterRunsEnabled", () => false);
  const jobId = downloadTracker.addJob({ artistName: "Failing Band", trackName: "Lost Song",
    albumName: "Lost Album", durationMs: 200000 }, "library");

  const first = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  const second = await processPipelinePayload(first);
  assert.equal(second.phase, "search");
  assert.equal(second.searchQueryIndex, 1);
  assert.notEqual(second.activeSearch.query, first.activeSearch.query);
  assert.equal(created.mock.callCount(), 2);
});

async function startSoulseek(t) {
  const soulseek = { loggedIn: false, searches: [], enqueues: [] };
  const loggedOut = (action) =>
    `The server connection must be connected and logged in to ${action} (currently: Connected, LoggingIn)`;
  const server = await createMockHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const send = (status, data) => {
        res.writeHead(status, { "content-type": typeof data === "string" ? "text/plain" : "application/json" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.method === "GET" && req.url === "/api/v0/application") {
        return send(200, { server: soulseek.loggedIn
          ? { state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true }
          : { state: "Connected, LoggingIn", isConnected: true, isLoggedIn: false } });
      }
      if (req.method === "GET" && req.url === "/api/v0/options") {
        return send(200, { directories: { downloads: "/downloads" } });
      }
      if (req.method === "POST" && req.url === "/api/v0/searches") {
        if (!soulseek.loggedIn) return send(409, loggedOut("perform a search"));
        soulseek.searches.push(JSON.parse(body));
        return send(200, { id: JSON.parse(body).id });
      }
      if (req.method === "POST" && req.url.startsWith("/api/v0/transfers/downloads/")) {
        if (!soulseek.loggedIn) return send(500, loggedOut("fetch user endpoint"));
        soulseek.enqueues.push(decodeURIComponent(req.url.split("/").pop()));
        return send(201, { enqueued: [{ id: "transfer-1" }], failed: [] });
      }
      if (req.method === "GET" && req.url.startsWith("/api/v0/events")) return send(200, []);
      return send(404, "");
    });
  });
  const originalSettings = dbOps.getSettings();
  resetDatabase(db);
  dbOps.updateSettings({ ...originalSettings, integrations: {
    ...originalSettings.integrations,
    slskd: { enabled: true, url: server.url },
    deemix: { enabled: true, url: "http://127.0.0.1:9" },
  } });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.after(async () => {
    dbOps.updateSettings(originalSettings);
    await server.close();
  });
  return soulseek;
}

function soulseekCandidate(user) {
  return { raw: { user, file: "Music\\Waiting Band\\Waiting Album\\01 - Song.flac", size: 30000000 } };
}

function transferHistoryCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM slskd_transfer_history").get().count;
}

test("a download waits while Soulseek logs in instead of skipping or blaming peers", async (t) => {
  const soulseek = await startSoulseek(t);
  const jobId = downloadTracker.addJob({ artistName: "Waiting Band", trackName: "Song" }, "library");
  const candidates = ["first-peer", "second-peer", "third-peer"].map(soulseekCandidate);

  const held = await processPipelinePayload({
    phase: "download", source: "slskd", jobId, candidates, candidateIndex: 0,
  });
  assert.equal(held.phase, "download");
  assert.equal(held.candidateIndex, 0);
  assert.ok(held.delaySeconds > 0);
  assert.equal(transferHistoryCount(), 0);

  t.mock.timers.tick(held.delaySeconds * 1000);
  const stillHeld = await processPipelinePayload(held);
  assert.equal(stillHeld.candidateIndex, 0);
  assert.equal(transferHistoryCount(), 0);
  assert.notEqual(downloadTracker.getJob(jobId).status, "failed");

  soulseek.loggedIn = true;
  t.mock.timers.tick(stillHeld.delaySeconds * 1000);
  const resumed = await processPipelinePayload(stillHeld);
  assert.equal(resumed.phase, "poll");
  assert.deepEqual(soulseek.enqueues, ["first-peer"]);
});

test("a search refused while Soulseek logs in waits and resumes after login", async (t) => {
  const soulseek = await startSoulseek(t);
  const jobId = downloadTracker.addJob({ artistName: "Waiting Band", trackName: "Song",
    albumName: "Waiting Album", durationMs: 200000 }, "library");

  const held = await processPipelinePayload({ phase: "search", source: "slskd", jobId });
  assert.equal(held.phase, "search");
  assert.equal(held.source, "slskd");
  assert.ok(held.delaySeconds > 0);
  assert.equal(downloadTracker.getJob(jobId).status, "downloading");

  t.mock.timers.tick(held.delaySeconds * 1000);
  const stillHeld = await processPipelinePayload(held);
  assert.equal(stillHeld.phase, "search");
  assert.equal(soulseek.searches.length, 0);

  soulseek.loggedIn = true;
  t.mock.timers.tick(stillHeld.delaySeconds * 1000);
  const resumed = await processPipelinePayload(stillHeld);
  assert.equal(resumed.phase, "search");
  assert.equal(soulseek.searches.length, 1);
  assert.equal(resumed.activeSearch.query, held.searchQueries[0]);
});

for (const phase of ["search", "download"]) {
  test(`a ${phase} tries the next source when Soulseek stays logged out past the wait limit`, async (t) => {
    await startSoulseek(t);
    const jobId = downloadTracker.addJob({ artistName: "Waiting Band", trackName: "Song",
      albumName: "Waiting Album", durationMs: 200000 }, "library");
    const heldAt = Date.now();
    let next = await processPipelinePayload({ phase, source: "slskd", jobId,
      candidates: [soulseekCandidate("first-peer")], candidateIndex: 0 });
    while (next?.source === "slskd" && Date.now() - heldAt < 2 * 60 * 60 * 1000) {
      t.mock.timers.tick(next.delaySeconds * 1000);
      next = await processPipelinePayload(next);
    }
    assert.equal(next.source, "deemix");
    assert.equal(next.phase, "search");
    assert.ok(Date.now() - heldAt >= 30 * 60 * 1000, "the wait must outlast a 30-minute Soulseek ban");
    assert.equal(transferHistoryCount(), 0);
  });
}
