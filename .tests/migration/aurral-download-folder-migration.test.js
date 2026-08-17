import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { migrateAurralDownloadFolder },
] = await setupIsolatedBackend(
  "aurral-download-folder-migration",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/aurralDownloadFolderMigration.js",
);

const root = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: {},
    flows: [],
    sharedPlaylists: [],
    onboardingComplete: true,
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("migrates permanent tracks, isolates active flows, and removes unkept flow files", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Saved" });
  const flow = flowPlaylistConfig.createFlow({ name: "Nightly", enabled: true });
  const permanentSource = path.join(
    root,
    "aurral-weekly-flow",
    playlist.id,
    "Artist",
    "Album",
    "Track.flac",
  );
  const flowSource = path.join(
    root,
    "aurral-weekly-flow",
    flow.id,
    "Artist",
    "Album",
    "Flow Track.flac",
  );
  const unkeptFlowSource = path.join(
    root,
    "aurral-weekly-flow",
    flow.id,
    "Artist",
    "Album",
    "Unkept.flac",
  );
  await Promise.all(
    [permanentSource, flowSource, unkeptFlowSource].map(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, filePath);
    }),
  );
  const permanentJobId = downloadTracker.addJob(
    { artistName: "Artist", albumName: "Album", trackName: "Track" },
    playlist.id,
  );
  const flowJobId = downloadTracker.addJob(
    { artistName: "Artist", albumName: "Album", trackName: "Flow Track" },
    flow.id,
  );
  downloadTracker.setDone(permanentJobId, permanentSource);
  downloadTracker.setDone(flowJobId, flowSource);

  const result = await migrateAurralDownloadFolder({
    root,
    indexDestination: async () => {},
  });

  const permanentDestination = path.join(root, "Artist", "Album", "Track.flac");
  const flowDestination = path.join(root, ".flows", flow.id, "Artist", "Album", "Flow Track.flac");
  assert.equal(result.migrated, 2);
  assert.equal(result.flowMigrated, 1);
  assert.equal(result.removed, 1);
  assert.equal(downloadTracker.getJob(permanentJobId).finalPath, permanentDestination);
  assert.equal(downloadTracker.getJob(flowJobId).finalPath, flowDestination);
  await assert.doesNotReject(() => fs.access(permanentDestination));
  await assert.doesNotReject(() => fs.access(flowDestination));
  await assert.rejects(() => fs.access(permanentSource));
  await assert.rejects(() => fs.access(flowSource));
  await assert.rejects(() => fs.access(unkeptFlowSource));
});

test("retains a failed item and completes it safely on retry", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Retry" });
  const source = path.join(
    root,
    "aurral-weekly-flow",
    playlist.id,
    "Artist",
    "Album",
    "Retry.flac",
  );
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "retry");
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", albumName: "Album", trackName: "Retry" },
    playlist.id,
  );
  downloadTracker.setDone(jobId, source);

  let shouldFail = true;
  let verifiedBeforeRemoval = false;
  const indexDestination = async () => {
    await fs.access(source);
    await fs.access(path.join(root, "Artist", "Album", "Retry.flac"));
    verifiedBeforeRemoval = true;
    if (shouldFail) throw new Error("index unavailable");
  };
  const first = await migrateAurralDownloadFolder({ root, indexDestination });
  assert.equal(first.failed, 1);
  assert.equal(verifiedBeforeRemoval, true);
  await assert.doesNotReject(() => fs.access(source));
  await assert.doesNotReject(() => fs.access(path.join(root, "Artist", "Album", "Retry.flac")));

  shouldFail = false;
  const second = await migrateAurralDownloadFolder({ root, indexDestination });
  assert.equal(second.migrated, 1);
  assert.equal(downloadTracker.getJob(jobId).finalPath, path.join(root, "Artist", "Album", "Retry.flac"));
  await assert.rejects(() => fs.access(source));

  const third = await migrateAurralDownloadFolder({ root, indexDestination });
  assert.equal(third.status, "complete");
  assert.equal(third.scanned, 0);
  assert.equal(third.migrated, 0);
});

test("retains partial and ambiguous files instead of guessing", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Review" });
  const partial = path.join(
    root,
    "aurral-weekly-flow",
    playlist.id,
    "Artist",
    "Album",
    "Partial.flac.part",
  );
  const ambiguous = path.join(
    root,
    "aurral-weekly-flow",
    playlist.id,
    "Unknown",
    "Unknown",
    "Ambiguous.flac",
  );
  await Promise.all(
    [partial, ambiguous].map(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "review");
    }),
  );

  const result = await migrateAurralDownloadFolder({
    root,
  });

  assert.equal(result.retained, 2);
  assert.equal(result.status, "needs-review");
  await assert.doesNotReject(() => fs.access(partial));
  await assert.doesNotReject(() => fs.access(ambiguous));
});

test("blocks migration when DL_FOLDER overlaps the Lidarr root", async () => {
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Protected" });
  const source = path.join(
    root,
    "aurral-weekly-flow",
    playlist.id,
    "Artist",
    "Album",
    "Protected.flac",
  );
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "protected");

  const result = await migrateAurralDownloadFolder({
    root,
    lidarrRoots: [root],
  });

  assert.equal(result.status, "blocked");
  await assert.doesNotReject(() => fs.access(source));
  await assert.rejects(() => fs.access(path.join(root, "Artist", "Album", "Protected.flac")));
});
