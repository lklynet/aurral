import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

type Payload = Parameters<typeof processPluginPipelinePayload>[0];

const [
  state,
  { db },
  { downloadTracker },
  { processPluginPipelinePayload },
  { pluginsDir },
  { stopAllPlugins },
  { refreshInstalledPlugins, updatePlugin },
  { getEnabledDownloadSources, getSourceLabel },
] = await setupIsolatedBackend(
  "plugin-download-source",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/plugins/pluginDownloadSource.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/downloadSourceService.ts"),
);

const SOURCE = `export default { downloadSource: {
  search: ({ track }) => [{ id: "t1", title: track.title, artist: track.artist, album: track.album, durationMs: 1000, format: "flac", source: "tape", data: { file: "t1.flac" } }],
  download: async ({ settings, result, directory }) => {
    const { copyFile } = await import("node:fs/promises");
    if (settings.escape) return { path: settings.fixture };
    await copyFile(settings.fixture, directory + "/" + result.data.file);
    return { path: result.data.file };
  },
} };`;

let fixtureDir = "";

async function installSource(settings: Record<string, unknown>) {
  const folder = path.join(pluginsDir(), "tapes");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      id: "tapes",
      name: "Tapes",
      version: "1.0.0",
      api: 1,
      downloadSource: true,
      settings: [
        { key: "fixture", label: "Fixture", type: "text" },
        { key: "escape", label: "Escape", type: "boolean" },
      ],
    }),
  );
  await writeFile(path.join(folder, "index.js"), SOURCE);
  await refreshInstalledPlugins();
  updatePlugin("tapes", { enabled: true, priority: 5, settings });
}

async function runToEnd(jobId: string) {
  const fail = async (_payload: Payload, _job: unknown, message: string) => {
    throw new Error(message);
  };
  let payload: Payload | null = { jobId, phase: "search", source: "plugin:tapes" };
  const phases: string[] = [];
  while (payload && payload.phase !== "done") {
    phases.push(payload.phase);
    const next: unknown = await processPluginPipelinePayload(payload, {
      failOrTryNextSource: fail,
    });
    payload = next && typeof next === "object" && "phase" in next ? (next as Payload) : null;
  }
  return phases;
}

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

test("a plugin source joins the download sources by its priority and name", async () => {
  await installSource({});
  const plugin = getEnabledDownloadSources().find((source) => source.id === "plugin:tapes");
  assert.equal(plugin?.priority, 5);
  assert.equal(getSourceLabel("plugin:tapes"), "Tapes");
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
