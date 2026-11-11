import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";
import { brainzmashGroup, serveGroups } from "../helpers/releaseFixture.ts";
import { createTrackedJob, trackedJob } from "../download/fixtures.ts";
import { insertJob } from "../helpers/jobs.ts";

type Payload = Parameters<typeof processPluginPipelinePayload>[0];

const [
  state,
  { db },
  { dbOps },
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
  () => import("../../backend/db/helpers/index.ts"),
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
  keepFiles: ({ id, paths }) => { kept[id] = paths; },
  status: async ({ settings, id, directory }) => {
    if (id === "a1") throw new Error("the client lost it");
    const { copyFile, mkdir } = await import("node:fs/promises");
    await mkdir(directory + "/Lowlands", { recursive: true });
    for (const path of kept[id]) await copyFile(settings.fixture, directory + "/" + path);
    return { done: true };
  },
  discard: () => {},
} };`;

const IN_PLACE_SOURCE = `export default { downloadSource: {
  search: ({ track }) => [{ id: "t1", title: track.title, artist: track.artist, album: track.album, durationMs: 1000, format: "flac" }],
  download: () => ({ pending: "t1" }),
  searchAlbum: ({ album }) => [{ id: "a1", title: album.title, artist: album.artist }],
  downloadAlbum: () => ({ pending: "a1" }),
  status: ({ settings }) => ({
    done: true,
    imported: ["01 Tide.flac", "02 Night Drive.flac"].map((name) => settings.imported + "/" + name),
  }),
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
        { key: "imported", label: "Imported", type: "text" },
      ],
    }),
  );
  await writeFile(path.join(folder, "index.js"), code);
  await refreshInstalledPlugins();
  updatePlugin("tapes", { enabled: true, priority: 5, settings });
}

async function runSteps(jobId: string, until: string, start: Partial<Payload> = {}) {
  const fail = async (_payload: Payload, _job: unknown, message: string) => {
    throw new Error(message);
  };
  let payload: Payload | null = { jobId, phase: "search", source: "plugin:tapes", ...start };
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

test("a source that files its own downloads has them checked and used where they are, in a read-only folder", async (t) => {
  const music = await realpath(fixtureDir);
  const imported = path.join(music, "Glass Coast");
  await mkdir(imported, { recursive: true });
  await writeFlacFixture(
    path.join(imported, "01 Harbor.flac"),
    { title: "Harbor", artist: "Glass Coast", album: "Breakwater", track: 1 },
    { seconds: 1 },
  );
  const [tide, nightDrive] = await Promise.all(
    ["Tide", "Night Drive"].map((title, index) =>
      writeFlacFixture(
        path.join(imported, `0${index + 1} ${title}.flac`),
        { title, artist: "Glass Coast", album: "Lowlands", track: index + 1 },
        { seconds: 1 },
      ),
    ),
  );
  assert.ok(tide && nightDrive);
  const before = await Promise.all([readFile(tide), readFile(nightDrive)]);
  await installSource({ imported }, { tracks: false, albums: true }, IN_PLACE_SOURCE);
  await serveGroups(t, [
    brainzmashGroup({
      id: "lowlands-group",
      title: "Lowlands",
      artist: "Glass Coast",
      releases: [
        {
          id: "lowlands-release",
          tracks: ["Tide", "Night Drive"].map((title) => ({ title, durationMs: 1000 })),
        },
      ],
    }),
  ]);
  const request = (trackName: string, trackNumber: number, playlist: string) =>
    createTrackedJob(
      downloadTracker,
      {
        artistName: "Glass Coast",
        trackName,
        albumName: "Lowlands",
        albumMbid: "lowlands-group",
        releaseMbid: "lowlands-release",
        trackNumber,
        durationMs: 1000,
      },
      playlist,
    );

  await assert.rejects(
    runToEnd(request("Night Drive", 2, "outside-read-only")),
    /download failed: imported .*\.flac, which isn't in a read-only folder/,
  );

  dbOps.setJSONSetting("readOnlyFolders", [music]);
  t.onTestFinished(() => dbOps.setJSONSetting("readOnlyFolders", []));
  const track = request("Night Drive", 2, "track-request");
  assert.deepEqual(await runToEnd(track), ["search", "download", "poll", "finalize"]);
  const album = request("Tide", 1, "album-request");
  await runSteps(album, "done", {
    albumGrab: true,
    albumGroupJobIds: [album],
    releaseMbid: "lowlands-release",
  });

  await installSource({ imported }, { albums: true }, IN_PLACE_SOURCE);
  const named = request("Night Drive", 2, "named-file");
  assert.deepEqual(await runToEnd(named), ["search", "download", "poll", "finalize"]);

  for (const [jobId, filePath] of [
    [track, nightDrive],
    [album, tide],
    [named, nightDrive],
  ] as const) {
    const job = trackedJob(downloadTracker, jobId);
    assert.equal(job.status, "done");
    assert.equal(job.finalPath, filePath);
    assert.equal(job.externalPath, filePath);
  }

  const upgrade = downloadTracker.addUpgradeJob(trackedJob(downloadTracker, track));
  assert.ok(upgrade);
  await assert.rejects(runToEnd(upgrade), /download failed: imported an upgrade itself/);
  assert.deepEqual(await Promise.all([readFile(tide), readFile(nightDrive)]), before);
});
