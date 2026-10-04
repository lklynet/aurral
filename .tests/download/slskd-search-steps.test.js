import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { dbOps }, { downloadTracker }, { getDownloadClient }, { processPipelinePayload }] =
  await setupIsolatedBackend(
    "slskd-search-steps",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/download/downloadClientSettings.js",
    "backend/services/slskdOrchestrator.js",
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
