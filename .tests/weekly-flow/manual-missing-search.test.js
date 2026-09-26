import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, trackerModule, searchService, orchestrator, qualityService, orchestratorWorker] = await setupIsolatedBackend(
  "manual-missing-search",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/manualMissingSearchService.js",
  "backend/services/slskdOrchestrator.js",
  "backend/services/qualityProfileService.js",
  "backend/services/slskdOrchestratorWorker.js",
);

const { WeeklyFlowDownloadTracker } = trackerModule;

test.beforeEach(() => {
  resetDatabase(db);
  searchService.clearManualMissingSearchSessions();
});

test.after(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("manual search exposes opaque result ids and binds the selection to its user and job", () => {
  const raw = {
    id: "provider-secret-id",
    title: "A Song",
    artist: "An Artist",
    url: "https://provider.invalid/credential-bearing-result",
    durationSec: 180,
  };
  const response = searchService.storeManualMissingSearch({
    jobId: "job-1",
    actorId: "user-1",
    sourceOption: { id: "deemix", label: "deemix", source: "deemix" },
    query: "An Artist A Song",
    rawResults: [raw],
  });

  assert.equal(response.results.length, 1);
  assert.notEqual(response.results[0].id, raw.id);
  assert.equal(JSON.stringify(response).includes(raw.url), false);
  assert.throws(
    () => searchService.takeManualMissingSelection({
      sessionId: response.sessionId,
      resultId: response.results[0].id,
      jobId: "job-1",
      actorId: "different-user",
    }),
    /expired/i,
  );

  const selection = searchService.takeManualMissingSelection({
    sessionId: response.sessionId,
    resultId: response.results[0].id,
    jobId: "job-1",
    actorId: "user-1",
  });
  assert.equal(selection.source, "deemix");
  assert.deepEqual(selection.candidate, { raw });
  assert.throws(
    () => searchService.takeManualMissingSelection({
      sessionId: response.sessionId,
      resultId: response.results[0].id,
      jobId: "job-1",
      actorId: "user-1",
    }),
    /expired/i,
  );
});

test("manual selection queues only the exact selected candidate", async () => {
  const tracker = new WeeklyFlowDownloadTracker();
  const jobId = tracker.addJob({ artistName: "An Artist", trackName: "A Song" }, "manual-test");
  tracker.setFailed(jobId, "Automatic search found nothing");
  const candidate = { raw: { id: "chosen", url: "https://provider.invalid/chosen" } };

  assert.equal(tracker.enqueueManualSelection(jobId, { source: "deemix", candidate }), true);
  const { listHonkerJobs } = await import("../../backend/services/honkerDb.js");
  const queued = listHonkerJobs("slskd-pipeline").find((entry) => entry.payload?.jobId === jobId);
  assert.ok(queued);
  assert.equal(queued.payload.phase, "download");
  assert.equal(queued.payload.source, "deemix");
  assert.equal(queued.payload.manualSelection, true);
  assert.deepEqual(queued.payload.allowedSources, ["deemix"]);
  assert.deepEqual(queued.payload.candidates, [candidate]);
});

test("manual pipeline failures cannot fall back to another source", () => {
  const next = orchestrator.buildNextSourcePayload({
    manualSelection: true,
    source: "deemix",
    allowedSources: ["deemix"],
  }, "deemix", "download failed");
  assert.equal(next, null);
});

test("unexpected manual download errors fail once instead of entering worker retry", async () => {
  const failures = [];
  const payload = { jobId: "job-1", source: "ytdlp", manualSelection: true };
  await orchestratorWorker.processOrchestratorJob(payload, {
    processPipelinePayload: async () => { throw new Error("selected result failed"); },
    continuePipeline: async () => { throw new Error("must not continue"); },
    failPipelineJob: async (failedPayload, message) => failures.push({ failedPayload, message }),
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].failedPayload, payload);
  assert.match(failures[0].message, /selected result failed/);

  await assert.rejects(
    orchestratorWorker.processOrchestratorJob(
      { jobId: "job-2", source: "ytdlp" },
      { processPipelinePayload: async () => { throw new Error("automatic retry"); } },
    ),
    /automatic retry/,
  );
});

test("manual selection overrides the automatic quality floor but still requires classifiable audio", () => {
  dbOps.updateSettings({
    integrations: {},
    qualityProfile: {
      order: ["flac-standard", "mp3-128"],
      enabled: ["flac-standard"],
      cutoff: "flac-standard",
    },
  });
  const parsed = { format: { container: "MPEG", lossless: false, bitrate: 128000 } };
  assert.equal(qualityService.validateParsedQuality(parsed, "track.mp3").valid, false);
  assert.equal(
    qualityService.validateParsedQuality(parsed, "track.mp3", { manualSelection: true }).valid,
    true,
  );
  assert.equal(
    qualityService.validateParsedQuality({ format: {} }, "track.bin", { manualSelection: true }).valid,
    false,
  );
});
