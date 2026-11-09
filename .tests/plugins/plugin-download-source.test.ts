import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";
import { createTrackedJob, trackedJob } from "../download/fixtures.ts";
import { insertJob } from "../helpers/jobs.ts";

type Payload = Parameters<typeof processPluginPipelinePayload>[0];

const [
  state,
  { db },
  { downloadTracker },
  { processPluginPipelinePayload },
  { pluginsDir },
  { stopAllPlugins },
  { refreshInstalledPlugins, updatePlugin },
  { getEnabledDownloadSources, getSourceLabel, upgradeSourceIds },
  { cancelDownloadWorkForJobs },
] = await setupIsolatedBackend(
  "plugin-download-source",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/plugins/pluginDownloadSource.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/downloadSourceService.ts"),
  () => import("../../backend/services/downloadJobs/downloadCancellationService.ts"),
);

const SOURCE = `let polls = 0;
export default { downloadSource: {
  search: ({ track }) => [{ id: "t1", title: track.title, artist: track.artist, album: track.album, durationMs: 1000, format: "flac", source: "tape", data: { file: "t1.flac" } }],
  download: async ({ settings, result, directory }) => {
    const { copyFile } = await import("node:fs/promises");
    if (settings.escape) return { path: settings.fixture };
    if (settings.pending) return { pending: "client-7" };
    await copyFile(settings.fixture, directory + "/" + result.data.file);
    return { path: result.data.file };
  },
  status: async ({ settings, id, directory, libraryFolder }) => {
    polls += 1;
    if (id !== "client-7" || !libraryFolder) throw new Error("wrong status input");
    if (settings.lost) throw new Error("the client lost it");
    if (polls < 2) return { done: false };
    const { copyFile } = await import("node:fs/promises");
    await copyFile(settings.fixture, directory + "/done.flac");
    return { done: true, path: "done.flac" };
  },
  discard: async ({ settings, id }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settings.fixture + ".discarded", id);
  },
} };`;

const ALBUM_SOURCE = `const kept = {};
export default { downloadSource: {
  searchAlbum: ({ album }) => ["a1", "a2"].map((id) => ({ id, title: album.title, artist: album.artist })),
  downloadAlbum: ({ result }) => ({ pending: result.id }),
  listFiles: () => [
    { path: "Lowlands/01 Tide.flac", size: 30000000 },
    { path: "Lowlands/02 Night Drive.flac", size: 30000000 },
  ],
  keepFile: ({ id, path }) => { kept[id] = path; },
  status: async ({ settings, id, directory }) => {
    if (id === "a1") throw new Error("the client lost it");
    const { copyFile, mkdir } = await import("node:fs/promises");
    await mkdir(directory + "/Lowlands", { recursive: true });
    await copyFile(settings.fixture, directory + "/" + kept[id]);
    return { done: true };
  },
  discard: () => {},
} };`;

let fixtureDir = "";

async function installSource(
  settings: Record<string, unknown>,
  downloadSource: Record<string, boolean> = {},
  code = SOURCE,
) {
  const folder = path.join(pluginsDir(), "tapes");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      id: "tapes",
      name: "Tapes",
      version: "1.0.0",
      api: 1,
      downloadSource,
      settings: [
        { key: "fixture", label: "Fixture", type: "text" },
        { key: "escape", label: "Escape", type: "boolean" },
        { key: "pending", label: "Pending", type: "boolean" },
        { key: "lost", label: "Lost", type: "boolean" },
      ],
    }),
  );
  await writeFile(path.join(folder, "index.js"), code);
  await refreshInstalledPlugins();
  updatePlugin("tapes", { enabled: true, priority: 5, settings });
}

async function runSteps(jobId: string, until: string) {
  const fail = async (_payload: Payload, _job: unknown, message: string) => {
    throw new Error(message);
  };
  let payload: Payload | null = { jobId, phase: "search", source: "plugin:tapes" };
  const phases: string[] = [];
  while (payload && payload.phase !== until) {
    phases.push(payload.phase);
    const next: unknown = await processPluginPipelinePayload(payload, {
      failOrTryNextSource: fail,
    });
    payload = next && typeof next === "object" && "phase" in next ? (next as Payload) : null;
  }
  return { phases, payload };
}

const runToEnd = async (jobId: string) => (await runSteps(jobId, "done")).phases;

beforeEach(async () => {
  resetDatabase(db);
  fixtureDir = await mkdtemp(path.join(tmpdir(), "aurral-plugin-source-"));
});

afterEach(async () => {
  stopAllPlugins();
  await rm(pluginsDir(), { recursive: true, force: true });
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("a plugin source joins the download sources by its priority and name, and upgrades when it says so", async () => {
  await installSource({});
  const plugin = getEnabledDownloadSources().find((source) => source.id === "plugin:tapes");
  assert.equal(plugin?.priority, 5);
  assert.equal(getSourceLabel("plugin:tapes"), "Tapes");
  assert.ok(!upgradeSourceIds().includes("plugin:tapes"));

  await installSource({}, { upgrades: true });
  assert.ok(upgradeSourceIds().includes("plugin:tapes"));
});

test("a plugin source's download is checked and filed in the Library", async () => {
  const fixture = await writeFlacFixture(
    path.join(fixtureDir, "source.flac"),
    { title: "Night Drive", artist: "Glass Coast", album: "Lowlands" },
    { seconds: 1 },
  );
  await installSource({ fixture });
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: "Night Drive",
      albumName: "Lowlands",
      durationMs: 1000,
    },
    "plugin-source",
  );

  assert.deepEqual(await runToEnd(jobId), ["search", "download", "finalize"]);
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  assert.equal(job.downloadSource, "plugin:tapes");
  await access(String(job.finalPath));
});

test("a plugin source can hand a download to its client and finish once status says done", async () => {
  const fixture = await writeFlacFixture(
    path.join(fixtureDir, "source.flac"),
    { title: "Night Drive", artist: "Glass Coast", album: "Lowlands" },
    { seconds: 1 },
  );
  await installSource({ fixture, pending: true });
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: "Night Drive",
      albumName: "Lowlands",
      durationMs: 1000,
    },
    "plugin-source",
  );

  assert.deepEqual(await runToEnd(jobId), ["search", "download", "poll", "poll", "finalize"]);
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  await access(String(job.finalPath));
});

test("a plugin source is told to discard a pending download that failed or was cancelled", async () => {
  const fixture = await writeFlacFixture(path.join(fixtureDir, "source.flac"), {}, { seconds: 1 });
  await installSource({ fixture, pending: true, lost: true });
  const track = () =>
    createTrackedJob(
      downloadTracker,
      { artistName: "Glass Coast", trackName: "Night Drive", durationMs: 1000 },
      "plugin-source",
    );
  const jobId = track();

  await assert.rejects(runToEnd(jobId), /download failed: the client lost it/);
  assert.equal(await readFile(`${fixture}.discarded`, "utf8"), "client-7");

  await rm(`${fixture}.discarded`);
  const cancelled = track();
  const { payload } = await runSteps(cancelled, "poll");
  assert.ok(payload);
  insertJob(db, "download-pipeline", payload);
  await cancelDownloadWorkForJobs([trackedJob(downloadTracker, cancelled)]);
  assert.equal(await readFile(`${fixture}.discarded`, "utf8"), "client-7");
});

test("a plugin source can't hand over a file outside its folder", async () => {
  const fixture = await writeFlacFixture(path.join(fixtureDir, "outside.flac"), {}, { seconds: 1 });
  await installSource({ fixture, escape: true });
  const jobId = createTrackedJob(
    downloadTracker,
    { artistName: "Glass Coast", trackName: "Night Drive", durationMs: 1000 },
    "plugin-source",
  );

  await assert.rejects(
    runToEnd(jobId),
    /download failed: returned a file outside the folder Aurral gave it/,
  );
  await access(fixture);
});

test("an album-only plugin source fills a track request with the one file it kept from the album", async () => {
  const fixture = await writeFlacFixture(
    path.join(fixtureDir, "source.flac"),
    { title: "Night Drive", artist: "Glass Coast", album: "Lowlands" },
    { seconds: 1 },
  );
  await installSource({ fixture }, { tracks: false, albums: true, files: true }, ALBUM_SOURCE);
  const jobId = createTrackedJob(
    downloadTracker,
    {
      artistName: "Glass Coast",
      trackName: "Night Drive",
      albumName: "Lowlands",
      durationMs: 1000,
    },
    "plugin-source",
  );

  assert.deepEqual(await runToEnd(jobId), [
    "search",
    "download",
    "poll",
    "download",
    "poll",
    "finalize",
  ]);
  const job = trackedJob(downloadTracker, jobId);
  assert.equal(job.status, "done");
  assert.equal(job.remoteFilename, "02 Night Drive.flac");
  await access(String(job.finalPath));
});
